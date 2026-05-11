import random
import threading
import time
from dataclasses import dataclass
from typing import Any, Dict, Iterable, Iterator, Optional

import requests
from msal import ConfidentialClientApplication

from app.runtime_config import get_float_runtime_env, get_int_runtime_env, get_runtime_env, require_runtime_env
from app.runtime_logger import emit


DEFAULT_GRAPH_BASE = "https://graph.microsoft.com/v1.0"


@dataclass(frozen=True)
class GraphError(Exception):
    status_code: int
    message: str
    url: str
    response_text: str = ""

    def __str__(self) -> str:
        return f"Graph error {self.status_code}: {self.message}"


class GraphClient:
    def __init__(self):
        self._graph_base = (get_runtime_env("GRAPH_BASE", DEFAULT_GRAPH_BASE) or DEFAULT_GRAPH_BASE).rstrip("/")

        tenant_id = require_runtime_env("ENTRA_TENANT_ID")
        client_id = require_runtime_env("ENTRA_CLIENT_ID")
        client_secret = require_runtime_env("ENTRA_CLIENT_SECRET")
        if not tenant_id or not client_id or not client_secret:
            raise RuntimeError("ENTRA_TENANT_ID/ENTRA_CLIENT_ID/ENTRA_CLIENT_SECRET must be set")

        self._max_retries = get_int_runtime_env("GRAPH_MAX_RETRIES", 5)
        self._connect_timeout = get_float_runtime_env("GRAPH_CONNECT_TIMEOUT", 10)
        self._read_timeout = get_float_runtime_env("GRAPH_READ_TIMEOUT", 60)

        self._cca = ConfidentialClientApplication(
            client_id,
            authority=f"https://login.microsoftonline.com/{tenant_id}",
            client_credential=client_secret,
        )
        self._token_lock = threading.Lock()
        self._cached_token: Optional[str] = None
        self._cached_token_expires_at: float = 0.0

    @property
    def base_url(self) -> str:
        return self._graph_base

    def _get_token(self) -> str:
        now = time.time()
        if self._cached_token and now < (self._cached_token_expires_at - 60):
            return self._cached_token

        with self._token_lock:
            now = time.time()
            if self._cached_token and now < (self._cached_token_expires_at - 60):
                return self._cached_token

            scopes = ["https://graph.microsoft.com/.default"]
            result = self._cca.acquire_token_silent(scopes, account=None)
            if not result:
                result = self._cca.acquire_token_for_client(scopes=scopes)
            access_token = result.get("access_token")
            if not access_token:
                emit("ERROR", "GRAPH", "Graph token acquisition failed: missing access_token")
                raise RuntimeError("Failed to acquire Graph token")

            expires_in = result.get("expires_in")
            if isinstance(expires_in, (int, float)):
                self._cached_token_expires_at = time.time() + float(expires_in)
            else:
                self._cached_token_expires_at = time.time() + 55 * 60
            self._cached_token = access_token
            return access_token

    def _build_url(self, path_or_url: str) -> str:
        if path_or_url.startswith("http://") or path_or_url.startswith("https://"):
            return path_or_url
        if not path_or_url.startswith("/"):
            path_or_url = "/" + path_or_url
        return f"{self._graph_base}{path_or_url}"

    def get_json(self, path_or_url: str) -> Dict[str, Any]:
        return self.request_json("GET", path_or_url)

    def get_text(self, path_or_url: str) -> str:
        return self.request_text("GET", path_or_url)

    def request_json(self, method: str, path_or_url: str, *, json: Any = None) -> Dict[str, Any]:
        url = self._build_url(path_or_url)
        backoff = 2.0

        for attempt in range(self._max_retries + 1):
            attempt_number = attempt + 1
            token = self._get_token()
            headers = {"Authorization": f"Bearer {token}"}
            try:
                resp = requests.request(
                    method,
                    url,
                    headers=headers,
                    json=json,
                    timeout=(self._connect_timeout, self._read_timeout),
                )
            except requests.RequestException as exc:
                if attempt >= self._max_retries:
                    emit("ERROR", "GRAPH", f"Graph request failed: method={method} url={url} error={exc}")
                    raise RuntimeError(f"Graph request failed: {exc}") from exc
                emit(
                    "WARN",
                    "GRAPH",
                    f"Graph request retrying after transport error: method={method} url={url} attempt={attempt_number}/{self._max_retries + 1} error={exc}",
                )
                time.sleep(backoff + random.uniform(0, 0.25))
                backoff = min(backoff * 2, 60)
                continue

            if resp.status_code == 401 and attempt < self._max_retries:
                self._cached_token = None
                self._cached_token_expires_at = 0.0
                emit(
                    "WARN",
                    "GRAPH",
                    f"Graph request retrying after 401: method={method} url={url} attempt={attempt_number}/{self._max_retries + 1}",
                )
                time.sleep(0.5)
                continue

            if resp.status_code in (408, 429, 500, 502, 503, 504) and attempt < self._max_retries:
                retry_after = resp.headers.get("Retry-After")
                emit(
                    "WARN",
                    "GRAPH",
                    f"Graph request retrying after status={resp.status_code}: method={method} url={url} attempt={attempt_number}/{self._max_retries + 1}",
                )
                if retry_after and retry_after.isdigit():
                    time.sleep(float(retry_after))
                else:
                    time.sleep(backoff + random.uniform(0, 0.25))
                    backoff = min(backoff * 2, 60)
                continue

            if not resp.ok:
                text = resp.text or ""
                emit(
                    "ERROR",
                    "GRAPH",
                    f"Graph request failed with status={resp.status_code}: method={method} url={url}",
                )
                raise GraphError(resp.status_code, "request_failed", url, text)

            if resp.status_code == 204:
                return {}
            try:
                return resp.json()
            except ValueError as exc:
                emit("ERROR", "GRAPH", f"Graph response invalid JSON: method={method} url={url}")
                raise RuntimeError("Graph response was not valid JSON") from exc

        emit("ERROR", "GRAPH", f"Graph request retries exhausted: method={method} url={url}")
        raise RuntimeError("Graph request retries exhausted")

    def request_text(self, method: str, path_or_url: str, *, json: Any = None) -> str:
        url = self._build_url(path_or_url)
        backoff = 2.0

        for attempt in range(self._max_retries + 1):
            attempt_number = attempt + 1
            token = self._get_token()
            headers = {"Authorization": f"Bearer {token}"}
            try:
                resp = requests.request(
                    method,
                    url,
                    headers=headers,
                    json=json,
                    timeout=(self._connect_timeout, self._read_timeout),
                )
            except requests.RequestException as exc:
                if attempt >= self._max_retries:
                    emit("ERROR", "GRAPH", f"Graph request failed: method={method} url={url} error={exc}")
                    raise RuntimeError(f"Graph request failed: {exc}") from exc
                emit(
                    "WARN",
                    "GRAPH",
                    f"Graph request retrying after transport error: method={method} url={url} attempt={attempt_number}/{self._max_retries + 1} error={exc}",
                )
                time.sleep(backoff + random.uniform(0, 0.25))
                backoff = min(backoff * 2, 60)
                continue

            if resp.status_code == 401 and attempt < self._max_retries:
                self._cached_token = None
                self._cached_token_expires_at = 0.0
                emit(
                    "WARN",
                    "GRAPH",
                    f"Graph request retrying after 401: method={method} url={url} attempt={attempt_number}/{self._max_retries + 1}",
                )
                time.sleep(0.5)
                continue

            if resp.status_code in (408, 429, 500, 502, 503, 504) and attempt < self._max_retries:
                retry_after = resp.headers.get("Retry-After")
                emit(
                    "WARN",
                    "GRAPH",
                    f"Graph request retrying after status={resp.status_code}: method={method} url={url} attempt={attempt_number}/{self._max_retries + 1}",
                )
                if retry_after and retry_after.isdigit():
                    time.sleep(float(retry_after))
                else:
                    time.sleep(backoff + random.uniform(0, 0.25))
                    backoff = min(backoff * 2, 60)
                continue

            if not resp.ok:
                text = resp.text or ""
                emit(
                    "ERROR",
                    "GRAPH",
                    f"Graph request failed with status={resp.status_code}: method={method} url={url}",
                )
                raise GraphError(resp.status_code, "request_failed", url, text)

            return resp.text or ""

        emit("ERROR", "GRAPH", f"Graph request retries exhausted: method={method} url={url}")
        raise RuntimeError("Graph request retries exhausted")

    def iter_paged(self, path_or_url: str) -> Iterator[Dict[str, Any]]:
        next_url: Optional[str] = self._build_url(path_or_url)
        while next_url:
            data = self.get_json(next_url)
            for item in data.get("value", []) or []:
                yield item
            next_url = data.get("@odata.nextLink")

    def collect_paged(self, path_or_url: str) -> list[Dict[str, Any]]:
        return list(self.iter_paged(path_or_url))


def chunks(items: Iterable[Any], size: int) -> Iterator[list[Any]]:
    batch: list[Any] = []
    for item in items:
        batch.append(item)
        if len(batch) >= size:
            yield batch
            batch = []
    if batch:
        yield batch
