# Copyright (c) 2025 PaddlePaddle Authors. All Rights Reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""
PaddleOCR Document Parsing Library

Simple document parsing API wrapper for PaddleOCR.
"""

import logging
import os
import json
import time
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse, unquote

import requests

logger = logging.getLogger(__name__)

# =============================================================================
# Constants
# =============================================================================

DEFAULT_TIMEOUT = 600  # seconds (10 minutes)
DEFAULT_POLL_INTERVAL = 5  # seconds
API_GUIDE_URL = "https://paddleocr.com"
DEFAULT_JOBS_URL = "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs"
DEFAULT_MODEL = "PaddleOCR-VL-1.5"
FILE_TYPE_PDF = 0
FILE_TYPE_IMAGE = 1
IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".bmp", ".tiff", ".tif", ".webp")


# =============================================================================
# Environment
# =============================================================================


def _get_env(key: str, *fallback_keys: str) -> str:
    """Get environment variable with fallback keys."""
    value = os.getenv(key, "").strip()
    if value:
        return value
    for fallback in fallback_keys:
        value = os.getenv(fallback, "").strip()
        if value:
            logger.debug(f"Using fallback env var: {fallback}")
            return value
    return ""


def get_config() -> tuple[str, str]:
    """
    Get API URL and token from environment.

    Returns:
        tuple of (api_url, token)

    Raises:
        ValueError: If not configured
    """
    api_url = _get_env("PADDLEOCR_JOBS_URL", "PADDLEOCR_DOC_PARSING_API_URL")
    token = _get_env("PADDLEOCR_ACCESS_TOKEN")

    if not api_url:
        api_url = DEFAULT_JOBS_URL
    if not token:
        raise ValueError(
            f"PADDLEOCR_ACCESS_TOKEN not configured. Get your API at: {API_GUIDE_URL}"
        )

    # Normalize URL
    if not api_url.startswith(("http://", "https://")):
        api_url = f"https://{api_url}"
    api_path = urlparse(api_url).path.rstrip("/")
    if api_path.endswith("/layout-parsing"):
        raise ValueError(
            "PADDLEOCR_DOC_PARSING_API_URL now uses the asynchronous jobs API. "
            f"Use {DEFAULT_JOBS_URL} or leave API URL empty to use the default."
        )
    if not api_path.endswith("/api/v2/ocr/jobs"):
        raise ValueError(
            "PADDLEOCR_DOC_PARSING_API_URL/PADDLEOCR_JOBS_URL must be the "
            "asynchronous PaddleOCR jobs endpoint ending with /api/v2/ocr/jobs. "
            f"Example: {DEFAULT_JOBS_URL}"
        )

    return api_url.rstrip("/"), token


def get_extra_options() -> dict[str, Any]:
    """Load optional JSON request parameters from environment."""
    raw = _get_env("PADDLEOCR_DOC_PARSING_EXTRA_OPTIONS")
    if not raw:
        return {}

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(
            "PADDLEOCR_DOC_PARSING_EXTRA_OPTIONS must be valid JSON"
        ) from exc

    if not isinstance(parsed, dict):
        raise ValueError(
            "PADDLEOCR_DOC_PARSING_EXTRA_OPTIONS must be a JSON object"
        )

    return parsed


# =============================================================================
# File Utilities
# =============================================================================


def _detect_file_type(path_or_url: str) -> int:
    """Detect file type: 0=PDF, 1=Image."""
    path = path_or_url.lower()
    if path.startswith(("http://", "https://")):
        path = unquote(urlparse(path).path)

    if path.endswith(".pdf"):
        return FILE_TYPE_PDF
    elif path.endswith(IMAGE_EXTENSIONS):
        return FILE_TYPE_IMAGE
    else:
        raise ValueError(f"Unsupported file format: {path_or_url}")


def _validate_local_file(file_path: str) -> str:
    """Validate a local file path and return it as a string."""
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"File not found: {file_path}")

    return str(path)


# =============================================================================
# API Request
# =============================================================================


def _env_flag(key: str) -> bool:
    return os.getenv(key, "").strip().lower() in {"1", "true", "yes", "on"}


def _is_ssl_eof_error(error: Exception) -> bool:
    message = str(error)
    return (
        "EOF occurred in violation of protocol" in message
        or ("SSL" in message and "EOF" in message)
    )


def _format_request_error(error: Exception, api_url: str) -> str:
    if _is_ssl_eof_error(error):
        parsed = urlparse(api_url)
        endpoint = f"{parsed.scheme}://{parsed.netloc}" if parsed.netloc else api_url
        return (
            "API request failed: SSL connection was closed by the endpoint or a "
            f"network proxy while connecting to {endpoint}. Verify that the API URL "
            "uses the correct http/https scheme and ends with /api/v2/ocr/jobs, then "
            "check proxy/firewall settings. If this is a trusted private endpoint "
            "with nonstandard TLS, set PADDLEOCR_DOC_PARSING_INSECURE_TLS=1 and retry. "
            f"Original error: {error}"
        )

    return f"API request failed: {error}"


def _request_headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"bearer {token}",
        "Client-Platform": "official-skill",
    }


def _response_error_detail(resp: requests.Response) -> str:
    try:
        error_body = resp.json()
    except ValueError:
        return (resp.text[:500] or "No response body").strip()

    if isinstance(error_body, dict):
        for key in ("errorMsg", "message", "msg", "error"):
            value = error_body.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        data = error_body.get("data")
        if isinstance(data, dict):
            value = data.get("errorMsg") or data.get("message")
            if isinstance(value, str) and value.strip():
                return value.strip()

    return str(error_body)[:500]


def _json_response(resp: requests.Response, context: str) -> dict[str, Any]:
    if resp.status_code != 200:
        detail = _response_error_detail(resp)
        if resp.status_code in (401, 403):
            raise RuntimeError(f"{context} authentication failed ({resp.status_code}): {detail}")
        if resp.status_code == 429:
            raise RuntimeError(f"{context} rate limit exceeded (429): {detail}")
        if resp.status_code >= 500:
            raise RuntimeError(f"{context} service error ({resp.status_code}): {detail}")
        raise RuntimeError(f"{context} error ({resp.status_code}): {detail}")

    try:
        parsed = resp.json()
    except ValueError:
        raise RuntimeError(f"{context} returned invalid JSON: {resp.text[:200]}")

    if not isinstance(parsed, dict):
        raise RuntimeError(f"{context} returned invalid JSON schema")

    return parsed


def _submit_job(
    api_url: str,
    token: str,
    file_path: Optional[str],
    file_url: Optional[str],
    optional_payload: dict[str, Any],
    timeout: float,
) -> str:
    headers = _request_headers(token)
    verify_tls = not _env_flag("PADDLEOCR_DOC_PARSING_INSECURE_TLS")

    try:
        if file_url:
            resp = requests.post(
                api_url,
                json={
                    "fileUrl": file_url,
                    "model": DEFAULT_MODEL,
                    "optionalPayload": optional_payload,
                },
                headers={**headers, "Content-Type": "application/json"},
                timeout=timeout,
                verify=verify_tls,
            )
        else:
            assert file_path is not None
            data = {
                "model": DEFAULT_MODEL,
                "optionalPayload": json.dumps(optional_payload, ensure_ascii=False),
            }
            with open(file_path, "rb") as file_obj:
                resp = requests.post(
                    api_url,
                    headers=headers,
                    data=data,
                    files={"file": file_obj},
                    timeout=timeout,
                    verify=verify_tls,
                )
    except requests.Timeout:
        raise RuntimeError(f"API job submission timed out after {timeout}s")
    except requests.RequestException as e:
        raise RuntimeError(_format_request_error(e, api_url))

    payload = _json_response(resp, "API job submission")
    data = payload.get("data")
    job_id = data.get("jobId") if isinstance(data, dict) else None
    if not isinstance(job_id, str) or not job_id.strip():
        raise RuntimeError("API job submission response missing data.jobId")

    logger.info("PaddleOCR job submitted: %s", job_id)
    return job_id


def _poll_job(
    api_url: str,
    token: str,
    job_id: str,
    timeout: float,
    poll_interval: float,
) -> dict[str, Any]:
    headers = _request_headers(token)
    verify_tls = not _env_flag("PADDLEOCR_DOC_PARSING_INSECURE_TLS")
    deadline = time.monotonic() + timeout

    while True:
        if time.monotonic() > deadline:
            raise RuntimeError(f"API job {job_id} timed out after {timeout}s")

        try:
            resp = requests.get(
                f"{api_url}/{job_id}",
                headers=headers,
                timeout=timeout,
                verify=verify_tls,
            )
        except requests.Timeout:
            raise RuntimeError(f"API job polling timed out after {timeout}s")
        except requests.RequestException as e:
            raise RuntimeError(_format_request_error(e, api_url))

        payload = _json_response(resp, "API job polling")
        data = payload.get("data")
        if not isinstance(data, dict):
            raise RuntimeError("API job polling response missing data object")

        state = data.get("state")
        if state in ("pending", "running"):
            progress = data.get("extractProgress")
            if isinstance(progress, dict):
                logger.info(
                    "PaddleOCR job %s %s: %s/%s pages",
                    job_id,
                    state,
                    progress.get("extractedPages", "?"),
                    progress.get("totalPages", "?"),
                )
            else:
                logger.info("PaddleOCR job %s %s", job_id, state)
            time.sleep(max(0.1, poll_interval))
            continue

        if state == "done":
            logger.info("PaddleOCR job completed: %s", job_id)
            return data

        if state == "failed":
            error_msg = data.get("errorMsg")
            raise RuntimeError(
                f"API job {job_id} failed: {error_msg if error_msg else 'Unknown error'}"
            )

        raise RuntimeError(f"API job {job_id} returned unknown state: {state}")


def _download_jsonl(jsonl_url: str, timeout: float) -> list[dict[str, Any]]:
    verify_tls = not _env_flag("PADDLEOCR_DOC_PARSING_INSECURE_TLS")
    try:
        resp = requests.get(jsonl_url, timeout=timeout, verify=verify_tls)
        resp.raise_for_status()
    except requests.Timeout:
        raise RuntimeError(f"API result download timed out after {timeout}s")
    except requests.RequestException as e:
        raise RuntimeError(f"API result download failed: {e}")

    pages: list[dict[str, Any]] = []
    for line_num, line in enumerate(resp.text.splitlines(), start=1):
        line = line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError as e:
            raise RuntimeError(f"Invalid JSONL result at line {line_num}: {e}")

        result = payload.get("result") if isinstance(payload, dict) else None
        if isinstance(result, dict):
            layout_results = result.get("layoutParsingResults")
            if isinstance(layout_results, list):
                pages.extend(item for item in layout_results if isinstance(item, dict))
        elif isinstance(result, list):
            pages.extend(item for item in result if isinstance(item, dict))

    if not pages:
        raise RuntimeError("API result JSONL did not contain layoutParsingResults")

    return pages


def _make_api_request(
    api_url: str,
    token: str,
    file_path: Optional[str],
    file_url: Optional[str],
    optional_payload: dict[str, Any],
) -> dict[str, Any]:
    timeout = float(os.getenv("PADDLEOCR_DOC_PARSING_TIMEOUT", str(DEFAULT_TIMEOUT)))
    poll_interval = float(
        os.getenv("PADDLEOCR_DOC_PARSING_POLL_INTERVAL", str(DEFAULT_POLL_INTERVAL))
    )

    job_id = _submit_job(api_url, token, file_path, file_url, optional_payload, timeout)
    job_result = _poll_job(api_url, token, job_id, timeout, poll_interval)
    result_url = job_result.get("resultUrl")
    jsonl_url = result_url.get("jsonUrl") if isinstance(result_url, dict) else None
    if not isinstance(jsonl_url, str) or not jsonl_url.strip():
        raise RuntimeError(f"API job {job_id} completed without resultUrl.jsonUrl")

    pages = _download_jsonl(jsonl_url, timeout)
    return {
        "result": {
            "layoutParsingResults": pages,
        },
        "job": {
            "jobId": job_id,
            "state": job_result.get("state"),
            "extractProgress": job_result.get("extractProgress"),
            "jsonUrl": jsonl_url,
        },
    }


# =============================================================================
# Main API
# =============================================================================


def parse_document(
    file_path: Optional[str] = None,
    file_url: Optional[str] = None,
    file_type: Optional[int] = None,
    **options,
) -> dict[str, Any]:
    """
    Parse document with PaddleOCR.

    Args:
        file_path: Local file path
        file_url: URL to file
        file_type: Optional file type override (0=PDF, 1=Image)
        **options: Additional API options

    Returns:
        {
            "ok": True,
            "text": "extracted text...",
            "result": { raw API result },
            "error": None
        }
        or on error:
        {
            "ok": False,
            "text": "",
            "result": None,
            "error": {"code": "...", "message": "..."}
        }
    """
    # Validate input
    if not file_path and not file_url:
        return _error("INPUT_ERROR", "file_path or file_url required")
    if file_type is not None and file_type not in (FILE_TYPE_PDF, FILE_TYPE_IMAGE):
        return _error("INPUT_ERROR", "file_type must be 0 (PDF) or 1 (Image)")

    # Get config
    try:
        api_url, token = get_config()
        extra_options = get_extra_options()
    except ValueError as e:
        return _error("CONFIG_ERROR", str(e))

    # Build request params
    try:
        if file_url:
            if file_type is None:
                _detect_file_type(file_url)
            resolved_file_url = file_url
            resolved_file_path = None
        else:
            assert file_path is not None
            if file_type is None:
                _detect_file_type(file_path)
            resolved_file_path = _validate_local_file(file_path)
            resolved_file_url = None

        optional_payload = dict(extra_options)
        optional_payload.update(options)

    except (ValueError, FileNotFoundError) as e:
        return _error("INPUT_ERROR", str(e))

    # Call API
    try:
        result = _make_api_request(
            api_url,
            token,
            resolved_file_path,
            resolved_file_url,
            optional_payload,
        )
    except RuntimeError as e:
        return _error("API_ERROR", str(e))

    # Extract text
    try:
        text = _extract_text(result)
    except ValueError as e:
        return _error("API_ERROR", str(e))

    return {
        "ok": True,
        "text": text,
        "result": result,
        "error": None,
    }


def _extract_text(result) -> str:
    """Extract text from document parsing result."""
    if not isinstance(result, dict):
        raise ValueError(
            "Invalid response schema: top-level response must be an object"
        )

    raw_result = result.get("result")
    if not isinstance(raw_result, dict):
        raise ValueError("Invalid response schema: missing result object")

    pages = raw_result.get("layoutParsingResults")
    if not isinstance(pages, list):
        raise ValueError(
            "Invalid response schema: result.layoutParsingResults must be an array"
        )

    texts = []
    for i, page in enumerate(pages):
        if not isinstance(page, dict):
            raise ValueError(
                f"Invalid response schema: result.layoutParsingResults[{i}] must be an object"
            )

        markdown = page.get("markdown")
        if not isinstance(markdown, dict):
            raise ValueError(
                f"Invalid response schema: result.layoutParsingResults[{i}].markdown must be an object"
            )

        text = markdown.get("text")
        if not isinstance(text, str):
            raise ValueError(
                f"Invalid response schema: result.layoutParsingResults[{i}].markdown.text must be a string"
            )
        texts.append(text)

    return "\n\n".join(texts)


def _error(code: str, message: str) -> dict:
    """Create error response."""
    return {
        "ok": False,
        "text": "",
        "result": None,
        "error": {"code": code, "message": message},
    }
