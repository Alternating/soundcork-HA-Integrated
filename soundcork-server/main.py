import asyncio
import logging
import os
import re
import secrets as _secrets_mod
import xml.etree.ElementTree as ET
from contextlib import asynccontextmanager
from datetime import datetime
from http import HTTPStatus
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Path, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi_etag import Etag

from soundcork.admin import get_admin_router
from soundcork.bmx import (
    play_custom_stream,
    tunein_navigate_profile_v1,
    tunein_navigate_v1,
    tunein_playback,
    tunein_playback_podcast,
    tunein_podcast_info,
    tunein_search_v1,
)
from soundcork.config import Settings
from soundcork.constants import ACCOUNT_RE, DEVICE_RE
from soundcork.datastore import DataStore
from soundcork.devices import (
    add_device,
    get_bose_devices,
    hostname_for_device,
    read_device_info,
    read_recents,
)
from soundcork.groups import get_groups_router
from soundcork.groups_service import get_groups_service_router
from soundcork.marge import (
    account_devices_xml,
    account_full_xml,
    account_sources_xml,
    add_device_to_account,
    add_recent,
    add_source_to_account,
    delete_preset,
    presets_xml,
    provider_settings_xml,
    recents_xml,
    remove_device_from_account,
    remove_source_from_account,
    rename_device,
    software_update_xml,
    source_providers,
    update_device_poweron,
    update_preset,
)
from soundcork.miniapp import get_miniapp_router
from soundcork.model import (
    BmxNavResponse,
    BmxPlaybackResponse,
    BmxPodcastInfoResponse,
    BmxResponse,
    BoseXMLResponse,
)
from soundcork.ui.speakers import Speakers
from soundcork.utils import strip_element_text

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger(__name__)

datastore = DataStore()
settings = Settings()
speakers = Speakers(datastore, settings)

from soundcork.speaker_allowlist import SpeakerAllowlist
from soundcork.spotify_service import SpotifyService

spotify_service = SpotifyService()

_speaker_allowlist: SpeakerAllowlist | None = None


def get_speaker_allowlist() -> SpeakerAllowlist:
    """Return the global speaker allowlist (lazy-init, patchable for tests)."""
    global _speaker_allowlist
    if _speaker_allowlist is None:
        _speaker_allowlist = SpeakerAllowlist(datastore)
    return _speaker_allowlist


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting up soundcork")

    # Refuse to start with default credentials
    if settings.mgmt_password == "change_me!":
        raise RuntimeError(
            "MGMT_PASSWORD is still the default 'change_me!'. "
            "Set a strong password via environment variable or .env.private."
        )

    # Initialise speaker allowlist at startup
    get_speaker_allowlist()
    logger.info("done starting up server")
    yield
    logger.debug("closing server")


description = """
This emulates the SoundTouch servers so you don't need connectivity
to use speakers.
"""

tags_metadata = [
    {
        "name": "marge",
        "description": "Communicates with the speaker.",
    },
    {
        "name": "service",
        "description": "Communicates with user applications.",
    },
    {
        "name": "bmx",
        "description": "Communicates with streaming radio services (eg. TuneIn).",
    },
]
app = FastAPI(
    title="SoundCork",
    description=description,
    summary="Emulates SoundTouch servers.",
    version="0.0.1",
    openapi_tags=tags_metadata,
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

origins = [
    "*",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

from fastapi.staticfiles import StaticFiles as _StaticFiles

_static_dir = os.path.join(os.path.dirname(__file__), "static")
if os.path.isdir(_static_dir):
    app.mount("/static", _StaticFiles(directory=_static_dir), name="static")

from soundcork.mgmt import router as mgmt_router
from soundcork.proxy import ProxyMiddleware

app.include_router(mgmt_router)

from fastapi.staticfiles import StaticFiles

from soundcork.oidc import router as oidc_router
from soundcork.webui.routes import router as webui_router

app.include_router(webui_router)
app.include_router(oidc_router)
app.mount(
    "/webui/static",
    StaticFiles(directory=os.path.join(os.path.dirname(__file__), "webui", "static")),
    name="webui_static",
)

app.add_middleware(ProxyMiddleware)


@app.middleware("http")
async def log_unknown_requests(request: Request, call_next):
    """Log unknown endpoints (404s) for API research.

    When LOG_REQUEST_BODY / LOG_REQUEST_HEADERS are enabled, body and
    headers are included in the log line -- but only for 404s.  Known
    endpoints are not logged here (they have their own logging).
    """
    body = b""
    if settings.log_request_body or settings.log_request_headers:
        body = await request.body()

    response = await call_next(request)

    if response.status_code == 404:
        query = str(request.url.query)
        query_str = f"?{query}" if query else ""
        body_str = ""
        if settings.log_request_body and body:
            body_str = " body=" + body[:2000].decode("utf-8", errors="replace")
        headers_str = ""
        if settings.log_request_headers:
            headers_str = (
                " headers={"
                + ", ".join(f"{k}: {v}" for k, v in request.headers.items() if k.lower() not in ("host",))
                + "}"
            )
        logger.info(
            "UNKNOWN %s %s%s [404]%s%s",
            request.method,
            request.url.path,
            query_str,
            headers_str,
            body_str,
        )

    return response


# --- Speaker IP restriction middleware ---
# Bose protocol endpoints are only accessible from registered speaker IPs.
# Paths starting with /webui, /mgmt, /docs, /openapi.json, or / (root) are exempt.

_EXEMPT_PREFIXES = ("/webui", "/mgmt", "/docs", "/openapi.json", "/auth")


@app.middleware("http")
async def speaker_ip_restriction(request: Request, call_next):
    """Block Bose protocol requests from unknown IPs."""
    path = request.url.path

    # Exempt paths: webui (browser), mgmt (has its own auth), docs, root health
    if path == "/" or any(path.startswith(p) for p in _EXEMPT_PREFIXES):
        return await call_next(request)

    # Determine client IP from X-Forwarded-For (behind ingress/proxy).
    # Take the LAST value: the reverse proxy (Traefik) appends the real client
    # IP as the rightmost entry.  Earlier entries are attacker-controlled.
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        client_ip = forwarded.split(",")[-1].strip()
    else:
        client_ip = request.client.host if request.client else ""

    allowlist = get_speaker_allowlist()
    if not allowlist.is_allowed(client_ip):
        logger.warning(
            "Blocked %s %s from %s (not a registered speaker)",
            request.method,
            path,
            client_ip,
        )
        return JSONResponse(
            {"detail": "Forbidden: unknown speaker IP"},
            status_code=403,
        )

    return await call_next(request)


# --- WebUI session auth middleware ---
# All /webui/* paths (except login page and static assets) require a session cookie.
from soundcork.webui.auth import is_webui_path_public
from soundcork.webui.routes import _SESSION_COOKIE, _session_store


@app.middleware("http")
async def webui_auth(request: Request, call_next):
    """Require session auth for all webui endpoints."""
    path = request.url.path

    # Only apply to /webui paths
    if not path.startswith("/webui"):
        return await call_next(request)

    # Public paths (login page, login endpoint, static assets)
    if is_webui_path_public(path):
        return await call_next(request)

    # Check session cookie
    session_id = request.cookies.get(_SESSION_COOKIE, "")
    csrf_token = _session_store.validate(session_id)
    if csrf_token is None:
        # API/WS requests get 401, HTML requests get redirect to login
        if path.startswith("/webui/api/") or path.startswith("/webui/ws/"):
            return JSONResponse({"detail": "Authentication required"}, status_code=401)
        return RedirectResponse(url="/webui/login", status_code=302)

    # CSRF check for mutating methods
    if request.method in ("POST", "PUT", "DELETE", "PATCH"):
        # Login endpoint is exempt (no session yet to have a CSRF token)
        if path != "/webui/api/login":
            csrf_header = request.headers.get("x-csrf-token", "")
            if not _secrets_mod.compare_digest(csrf_header, csrf_token):
                return JSONResponse({"detail": "CSRF token invalid"}, status_code=403)

    return await call_next(request)


startup_timestamp = int(datetime.now().timestamp() * 1000)


@app.get("/")
def read_root():
    return {"Bose": "Can't Brick Us"}


@app.post(
    "/marge/streaming/support/power_on",
    tags=["marge"],
)
async def power_on(request: Request, response: Response) -> Response:
    # Spotify priming is handled by the on-speaker boot primer
    # (/mnt/nv/spotify-boot-primer) which fetches a token from
    # GET /mgmt/spotify/token and primes locally via ZeroConf.
    # No server-side priming needed.
    logger.info("power_on from %s", request.headers.get("x-forwarded-for", "unknown"))
    xml = await request.body()
    account = update_device_poweron(datastore, xml)
    if account:
        response.status_code = HTTPStatus.OK
        return response
    else:
        response = BoseXMLResponse()
        element = ET.Element("status")
        ET.SubElement(element, "message").text = "Device does not exist"
        ET.SubElement(element, "status-code").text = "4012"
        response.body = bose_xml_str(element).encode()
        response.headers["Content-Length"] = str(len(response.body))
        response.status_code = HTTPStatus.BAD_REQUEST
        return response


@app.post(
    "/v1/scmudc/{device_id}",
    tags=["analytics"],
    status_code=HTTPStatus.OK,
)
async def scmudc_telemetry(device_id: str, request: Request):
    """Device telemetry event stream (analytics).

    The speaker posts real-time events here: power state changes,
    playback state, volume changes, source switches, art updates, etc.
    This is Bose's analytics/telemetry endpoint -- equivalent to
    POST /v1/stapp/{deviceId} used by the mobile app (Stockholm).

    The speaker sends events regardless of whether the server accepts
    them (fire-and-forget).  Returning 200 OK silences the 404 noise.

    See: https://github.com/gesellix/Bose-SoundTouch/blob/main/docs/reference/CLOUD-API.md
    """
    body = await request.body()
    logger.debug("scmudc event from %s: %s", device_id, body[:500])
    return Response(status_code=200)


##############################################################################
# Telemetry / analytics stubs
#
# These endpoints receive fire-and-forget data from the speaker.  The real
# Bose servers stored it; we just return 200 OK to prevent 404 log noise.
##############################################################################


@app.post(
    "/v1/stapp/{device_id}",
    tags=["analytics"],
    status_code=HTTPStatus.OK,
)
async def stapp_telemetry(device_id: str, request: Request):
    """SoundTouch app analytics -- equivalent to scmudc but used by the mobile app.

    Request format: same JSON envelope/payload as scmudc (already documented in #200).
    Response: bare 200 OK, no body.  Fire-and-forget.
    """
    body = await request.body()
    logger.debug("stapp event from %s: %s", device_id, body[:500])
    return Response(status_code=200)


@app.post(
    "/streaming/stats/usage",
    tags=["analytics"],
    status_code=HTTPStatus.OK,
)
async def streaming_stats_usage(request: Request):
    """Device usage statistics (play time, source stats, etc.).

    Real server (streaming.bose.com) still alive -- returns 400 "Invalid
    version in header(SOf)" without proper headers.  Request format is
    XML or JSON with deviceId, accountId, timestamp, eventType, parameters.
    Response: bare 200 OK, no body.

    Logging enabled to capture actual speaker payloads.
    """
    body = await request.body()
    if body:
        content_type = request.headers.get("content-type", "")
        headers = {k: v for k, v in request.headers.items() if k.lower() != "host"}
        logger.info(
            "STUB stats/usage content-type=%s headers=%s body=%s",
            content_type,
            headers,
            body[:2000].decode("utf-8", errors="replace"),
        )
    return Response(status_code=200)


@app.post(
    "/streaming/stats/error",
    tags=["analytics"],
    status_code=HTTPStatus.OK,
)
async def streaming_stats_error(request: Request):
    """Device error statistics (connection failures, codec errors, etc.).

    Request format: XML or JSON with deviceId, errorCode, errorMessage,
    timestamp, details.  Response: bare 200 OK, no body.

    Logging enabled to capture actual speaker payloads.
    """
    body = await request.body()
    if body:
        content_type = request.headers.get("content-type", "")
        headers = {k: v for k, v in request.headers.items() if k.lower() != "host"}
        logger.info(
            "STUB stats/error content-type=%s headers=%s body=%s",
            content_type,
            headers,
            body[:2000].decode("utf-8", errors="replace"),
        )
    return Response(status_code=200)


@app.post(
    "/bmx/tunein/v1/report",
    tags=["analytics"],
    status_code=HTTPStatus.OK,
)
async def bmx_tunein_report(request: Request):
    """TuneIn playback reporting (listen time, station stats).

    Real server (content.api.bose.io) still alive -- returns 403
    "Invalid client id".  Request format unknown.

    Logging enabled to capture actual speaker payloads.
    """
    body = await request.body()
    if body:
        content_type = request.headers.get("content-type", "")
        headers = {k: v for k, v in request.headers.items() if k.lower() != "host"}
        logger.info(
            "STUB bmx/tunein/report content-type=%s headers=%s body=%s",
            content_type,
            headers,
            body[:2000].decode("utf-8", errors="replace"),
        )
    return Response(status_code=200)


##############################################################################
# Customer / account profile
#
# Response format aligned with gesellix/Bose-SoundTouch Go implementation:
# root element <customer>, Content-Type: application/xml.
# Real Bose server (streaming.bose.com) still returns 406 with ETag --
# alive but wants a specific Accept header.
##############################################################################


@app.get(
    "/customer/account/{account}",
    tags=["customer"],
)
def customer_account_profile(account: str):
    """Returns account profile.  XML root: <customer>."""
    profile = ET.Element("customer")
    ET.SubElement(profile, "accountID").text = account
    ET.SubElement(profile, "email").text = "user@example.com"
    ET.SubElement(profile, "firstName").text = "SoundTouch"
    ET.SubElement(profile, "lastName").text = "User"
    ET.SubElement(profile, "countryCode").text = "US"
    ET.SubElement(profile, "languageCode").text = "en"
    ET.SubElement(profile, "street")
    ET.SubElement(profile, "city")
    ET.SubElement(profile, "postalCode")
    ET.SubElement(profile, "state")
    ET.SubElement(profile, "phone")
    ET.SubElement(profile, "marketingOptIn").text = "false"
    xml_str = bose_xml_str(profile)
    return Response(content=xml_str, media_type="application/xml")


@app.post(
    "/customer/account/{account}",
    tags=["customer"],
    status_code=HTTPStatus.OK,
)
async def update_customer_account_profile(account: str, request: Request):
    """Accept account profile update.  Request format unknown -- logging."""
    body = await request.body()
    if body:
        content_type = request.headers.get("content-type", "")
        headers = {k: v for k, v in request.headers.items() if k.lower() != "host"}
        logger.info(
            "STUB customer/account/%s (update) content-type=%s headers=%s body=%s",
            account,
            content_type,
            headers,
            body[:2000].decode("utf-8", errors="replace"),
        )
    return Response(status_code=200)


@app.post(
    "/customer/account/{account}/password",
    tags=["customer"],
    status_code=HTTPStatus.OK,
)
async def change_customer_password(account: str, request: Request):
    """Accept password change.  Request format unknown -- logging."""
    body = await request.body()
    if body:
        content_type = request.headers.get("content-type", "")
        logger.info(
            "STUB customer/account/%s/password content-type=%s body=%s",
            account,
            content_type,
            body[:2000].decode("utf-8", errors="replace"),
        )
    return Response(status_code=200)


##############################################################################
# Additional marge stubs
#
# Endpoints the speaker calls that were missing from soundcork but present
# in the Go implementation (gesellix/Bose-SoundTouch).
##############################################################################


@app.post(
    "/marge/streaming/support/customersupport",
    tags=["marge"],
    status_code=HTTPStatus.OK,
)
async def customer_support_upload(request: Request):
    """Accept customer support diagnostic upload.

    Go implementation expects <device-data> XML with device info and
    diagnostic-data (RSSI, gateway IP, MAC addresses, etc.).
    Response: 200 OK, Content-Type: application/vnd.bose.streaming-v1.2+xml.

    Logging enabled to capture actual speaker payloads.
    """
    body = await request.body()
    if body:
        content_type = request.headers.get("content-type", "")
        headers = {k: v for k, v in request.headers.items() if k.lower() != "host"}
        logger.info(
            "STUB customersupport content-type=%s headers=%s body=%s",
            content_type,
            headers,
            body[:2000].decode("utf-8", errors="replace"),
        )
    return Response(
        status_code=200,
        media_type="application/vnd.bose.streaming-v1.2+xml",
    )


@app.get(
    "/marge/streaming/device_setting/account/{account}/device/{device}/device_settings",
    tags=["marge"],
)
def get_device_settings(account: str, device: str):
    """Returns device settings.  XML root: <deviceSettings>."""
    device_settings = ET.Element("deviceSettings")
    setting = ET.SubElement(device_settings, "deviceSetting")
    ET.SubElement(setting, "name").text = "CLOCK_FORMAT"
    ET.SubElement(setting, "value").text = "24HR"
    xml_str = bose_xml_str(device_settings)
    return Response(content=xml_str, media_type="application/xml")


@app.post(
    "/marge/streaming/device_setting/account/{account}/device/{device}/device_settings",
    tags=["marge"],
    status_code=HTTPStatus.OK,
)
async def update_device_settings(account: str, device: str, request: Request):
    """Accept device settings update.  Request format unknown -- logging."""
    body = await request.body()
    if body:
        content_type = request.headers.get("content-type", "")
        logger.info(
            "STUB device_settings/%s/%s (update) content-type=%s body=%s",
            account,
            device,
            content_type,
            body[:2000].decode("utf-8", errors="replace"),
        )
    return Response(status_code=200)


@app.get(
    "/marge/streaming/account/{account}/emailaddress",
    tags=["marge"],
)
def get_email_address(account: str):
    """Returns the account email address.  XML root: <emailAddress>."""
    xml_str = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><emailAddress>user@example.com</emailAddress>'
    return Response(content=xml_str, media_type="application/xml")


@app.post(
    "/oauth/device/{device_id}/music/musicprovider/{provider_id}/token/{token_type}",
    tags=["oauth"],
    status_code=HTTPStatus.OK,
)
def oauth_token_refresh(device_id: str, provider_id: str, token_type: str):
    """Spotify OAuth token refresh endpoint.

    Intercepts the speaker's token refresh requests that would normally
    go to streamingoauth.bose.com.  The speaker calls this when it needs
    a fresh Spotify access token for playback.

    Only handles provider 15 (Spotify).  Other providers return 404.
    """
    if provider_id != "15":
        logger.info(
            "OAuth token request for unsupported provider %s (device=%s)",
            provider_id,
            device_id,
        )
        return Response(status_code=404)

    token = spotify_service.get_fresh_token_sync()
    if not token:
        logger.warning(
            "OAuth token refresh failed -- no Spotify token available (device=%s)",
            device_id,
        )
        return JSONResponse(
            status_code=500,
            content={
                "error": "no_token",
                "error_description": "No Spotify account linked",
            },
        )

    logger.info("OAuth token refresh for device %s (provider=Spotify)", device_id)
    return JSONResponse(
        content={
            "access_token": token,
            "token_type": "Bearer",
            "expires_in": 3600,
            "scope": (
                "streaming user-read-email user-read-private"
                " playlist-read-private playlist-read-collaborative user-library-read"
                " user-read-playback-state user-modify-playback-state"
                " user-read-currently-playing user-read-recently-played"
            ),
        }
    )


@app.get(
    "/marge/streaming/device/{device}/streaming_token",
    response_class=BoseXMLResponse,
    tags=["marge"],
)
def streaming_token(device: str, request: Request):
    """Streaming token endpoint.

    Returns a local bearer token matching the gesellix/Bose-SoundTouch
    Go implementation's st-local-token-{timestamp} pattern. The speaker
    accepts this for local operation.
    """
    token_value = f"st-local-token-{int(datetime.now().timestamp())}"
    bearer = f"Bearer {token_value}"
    logger.info("streaming_token request for device %s (returning local token)", device)
    xml_str = f'<?xml version="1.0" encoding="UTF-8"?><bearertoken value="{bearer}"/>'
    response = Response(
        content=xml_str,
        status_code=200,
        media_type="application/vnd.bose.streaming-v1.2+xml",
    )
    response.headers["Authorization"] = bearer
    return response


@app.get("/marge/streaming/sourceproviders", tags=["marge"])
def streamingsourceproviders():
    return_xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sourceProviders>'
    for provider in source_providers():
        return_xml = (
            return_xml
            + '<sourceprovider id="'
            + str(provider.id)
            + '">'
            + "<createdOn>"
            + provider.created_on
            + "</createdOn>"
            + "<name>"
            + provider.name
            + "</name>"
            + "<updatedOn>"
            + provider.updated_on
            + "</updatedOn>"
            "</sourceprovider>"
        )
    return_xml = return_xml + "</sourceProviders>"
    response = Response(content=return_xml, media_type="application/xml")
    # TODO: move content type to constants
    response.headers["content-type"] = "application/vnd.bose.streaming-v1.2+xml"
    # sourceproviders seems to return now as its etag
    etag = int(datetime.now().timestamp() * 1000)
    response.headers["ETag"] = str(etag)
    return response


def etag_for_presets(request: Request) -> str:
    return str(datastore.etag_for_presets(str(request.path_params.get("account"))))


def etag_for_recents(request: Request) -> str:
    return str(datastore.etag_for_recents(str(request.path_params.get("account"))))


def etag_for_account(request: Request) -> str:
    return str(datastore.etag_for_account(str(request.path_params.get("account"))))


def etag_for_sources(request: Request) -> str:
    return str(datastore.etag_for_sources(str(request.path_params.get("account"))))


def etag_for_swupdate(request: Request) -> str:
    return "1663726921993"


@app.get(
    "/marge/streaming/account/{account}/device/{device}/presets",
    response_class=BoseXMLResponse,
    tags=["marge"],
    dependencies=[
        Depends(
            Etag(
                etag_gen=etag_for_presets,
                weak=False,
            )
        )
    ],
)
def account_presets(
    account: Annotated[str, Path(pattern=ACCOUNT_RE)],
    device: Annotated[str, Path(pattern=DEVICE_RE)],
    response: Response,
):
    xml = presets_xml(datastore, account, device)
    return bose_xml_str(xml)


@app.get(
    "/marge/streaming/account/{account}/presets/all",
    response_class=BoseXMLResponse,
    tags=["marge"],
    dependencies=[
        Depends(
            Etag(
                etag_gen=etag_for_presets,
                weak=False,
            )
        )
    ],
)
def account_presets_all(
    account: Annotated[str, Path(pattern=ACCOUNT_RE)],
):
    # TODO bose actually returns a full set of all presets that have ever
    # been set. we could support that at least for all presets that were
    # ever set in soundcork. but for now just returning the current
    # presets should be ok.
    xml = presets_xml(datastore, account)
    return bose_xml_str(xml)


@app.put(
    "/marge/streaming/account/{account}/device/{device}/preset/{preset_number}",
    response_class=BoseXMLResponse,
    tags=["marge"],
    dependencies=[
        Depends(
            Etag(
                etag_gen=etag_for_presets,
                weak=False,
            )
        )
    ],
)
async def put_account_preset(
    account: Annotated[str, Path(pattern=ACCOUNT_RE)],
    device: Annotated[str, Path(pattern=DEVICE_RE)],
    preset_number: int,
    request: Request,
):
    xml = await request.body()
    xml_resp = update_preset(datastore, account, device, preset_number, xml)
    return bose_xml_str(xml_resp)


@app.delete(
    "/marge/streaming/account/{account}/device/{device}/preset/{preset_number}",
    response_class=BoseXMLResponse,
    tags=["marge"],
)
def delete_account_preset(
    account: Annotated[str, Path(pattern=ACCOUNT_RE)],
    device: Annotated[str, Path(pattern=DEVICE_RE)],
    preset_number: int,
):
    delete_preset(datastore, account, device, preset_number)
    return None


@app.get(
    "/marge/streaming/account/{account}/device/{device}/recents",
    response_class=BoseXMLResponse,
    tags=["marge"],
    dependencies=[
        Depends(
            Etag(
                etag_gen=etag_for_recents,
                weak=False,
            )
        )
    ],
)
def account_recents(
    account: Annotated[str, Path(pattern=ACCOUNT_RE)],
    device: Annotated[str, Path(pattern=DEVICE_RE)],
):
    xml = recents_xml(datastore, account, device)
    return bose_xml_str(xml)


@app.get(
    "/marge/streaming/account/{account}/provider_settings",
    response_class=BoseXMLResponse,
    tags=["marge"],
    dependencies=[
        Depends(
            Etag(
                etag_gen=etag_for_sources,
                weak=False,
                extra_headers={"method_name": "getProviderSettings"},
            )
        )
    ],
)
def account_provider_settings(account: Annotated[str, Path(pattern=ACCOUNT_RE)]):
    xml = provider_settings_xml(account)
    return bose_xml_str(xml)


@app.post(
    "/marge/streaming/music/musicprovider/{provider_id}/is_eligible",
    response_class=BoseXMLResponse,
    tags=["marge"],
)
def account_provider_eligibility(provider_id: str):
    # we could parse out the payload and get the account id but why bother?
    xml = provider_settings_xml("fake", provider_id)
    return bose_xml_str(xml)


@app.get(
    "/marge/streaming/software/update/account/{account}",
    response_class=BoseXMLResponse,
    dependencies=[Depends(Etag(etag_gen=etag_for_swupdate, weak=False))],
    tags=["marge"],
)
def software_update(account: Annotated[str, Path(pattern=ACCOUNT_RE)]):
    xml = software_update_xml()
    return bose_xml_str(xml)


@app.get(
    "/marge/streaming/account/{account}/full",
    response_class=BoseXMLResponse,
    tags=["marge"],
    dependencies=[
        Depends(
            Etag(
                etag_gen=etag_for_account,
                weak=False,
                extra_headers={"method_name": "getFullAccount"},
            )
        )
    ],
)
def account_full(account: Annotated[str, Path(pattern=ACCOUNT_RE)]) -> str:
    xml = account_full_xml(account, datastore)
    return bose_xml_str(xml)


@app.get(
    "/marge/streaming/account/{account}/devices",
    response_class=BoseXMLResponse,
    tags=["marge"],
    dependencies=[
        Depends(
            Etag(
                etag_gen=etag_for_account,
                weak=False,
                extra_headers={"method_name": "getDevices"},
            )
        )
    ],
)
def account_devices(account: Annotated[str, Path(pattern=ACCOUNT_RE)]) -> str:
    xml = account_devices_xml(account, datastore)
    return bose_xml_str(xml)


@app.post(
    "/marge/streaming/account/{account}/device/{device}/recent",
    response_class=BoseXMLResponse,
    tags=["marge"],
    dependencies=[Depends(Etag(etag_gen=etag_for_recents, weak=False))],
)
async def post_account_recent(
    account: Annotated[str, Path(pattern=ACCOUNT_RE)],
    device: Annotated[str, Path(pattern=DEVICE_RE)],
    request: Request,
):
    xml = await request.body()
    xml_resp = add_recent(datastore, account, device, xml)
    return bose_xml_str(xml_resp)


@app.post(
    "/marge/streaming/account/{account}/device/",
    response_class=BoseXMLResponse,
    tags=["marge"],
    status_code=HTTPStatus.CREATED,
    dependencies=[
        Depends(
            Etag(
                etag_gen=etag_for_account,
                weak=False,
                extra_headers={
                    "method_name": "addDevice",
                    "access-control-expose-headers": "Credentials",
                },
            )
        )
    ],
)
async def post_account_device(
    account: Annotated[str, Path(pattern=ACCOUNT_RE)],
    request: Request,
):
    xml = await request.body()
    device_id, xml_resp = add_device_to_account(datastore, account, xml.decode())

    return bose_xml_str(xml_resp)


@app.put(
    "/marge/streaming/account/{account}/device/{device_id}",
    response_class=BoseXMLResponse,
    tags=["marge"],
    status_code=HTTPStatus.CREATED,
    dependencies=[
        Depends(
            Etag(
                etag_gen=etag_for_account,
                weak=False,
                extra_headers={
                    "method_name": "putDevice",
                },
            )
        )
    ],
)
async def put_account_device(
    account: Annotated[str, Path(pattern=ACCOUNT_RE)],
    device_id: Annotated[str, Path(pattern=DEVICE_RE)],
    request: Request,
):
    xml = await request.body()
    xml_resp = rename_device(datastore, account, device_id, xml.decode())

    return bose_xml_str(xml_resp)


@app.delete("/marge/streaming/account/{account}/device/{device}", tags=["marge"])
async def delete_account_device(
    account: Annotated[str, Path(pattern=ACCOUNT_RE)],
    device: Annotated[str, Path(pattern=DEVICE_RE)],
    response: Response,
):
    remove_device_from_account(datastore, account, device)
    response.headers["method_name"] = "removeDevice"
    response.headers["location"] = f"{settings.base_url}/marge/account/{account}/device/{device}"
    response.body = b""
    response.status_code = HTTPStatus.OK
    return response


@app.post("/marge/streaming/account/login", tags=["marge"])
async def post_account_login(
    request: Request,
):
    xml = await request.body()
    # for now if they send in an account id as the username
    # then log in that account
    try:
        login_xml = ET.fromstring(xml)
        if login_xml:
            username = strip_element_text(login_xml.find("username"))
            # only use the beginning of the username so that we can accept
            # the account as an email address
            if len(username) > 7:
                username = username[:7]
            account_pattern = re.compile(ACCOUNT_RE)
            if account_pattern.match(username):
                account_id = username
            else:
                raise Exception
    except Exception:
        exception_xml = """<status>
        <message>Account Login failure.</message>
        <status-code>4024</status-code>
        </status>"""
        response = Response(content=exception_xml, media_type="application/xml")
        response.status_code = HTTPStatus.BAD_REQUEST
        return response

    account_elem = ET.Element("account")
    account_elem.attrib["id"] = account_id
    ET.SubElement(account_elem, "accountStatus").text = "OK"
    ET.SubElement(account_elem, "mode").text = "global"
    ET.SubElement(account_elem, "preferredLanguage").text = "en"

    account_str = ET.tostring(account_elem, encoding="unicode")
    return_xml = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>{account_str}'
    response = Response(content=return_xml, media_type="application/xml")
    # TODO: move content type to constants
    response.headers["content-type"] = "application/vnd.bose.streaming-v1.2+xml"

    etag = startup_timestamp

    response.headers["etag"] = str(etag)
    # just making this up
    response.headers["Credentials"] = "3432143243243432143fdafd"
    return response


@app.get(
    "/marge/streaming/account/{account}/sources",
    response_class=BoseXMLResponse,
    tags=["marge"],
    dependencies=[
        Depends(
            Etag(
                etag_gen=etag_for_sources,
                weak=False,
            )
        )
    ],
)
def get_account_sources(account: Annotated[str, Path(pattern=ACCOUNT_RE)]) -> str:
    xml = account_sources_xml(account, datastore)
    return bose_xml_str(xml)


@app.post(
    "/marge/streaming/account/{account}/source",
    response_class=BoseXMLResponse,
    tags=["marge"],
    status_code=HTTPStatus.CREATED,
    dependencies=[
        Depends(
            Etag(
                etag_gen=etag_for_account,
                weak=False,
                extra_headers={
                    "method_name": "addSource",
                },
            )
        )
    ],
)
async def post_account_source(
    account: Annotated[str, Path(pattern=ACCOUNT_RE)],
    request: Request,
):
    xml = await request.body()
    xml_resp = add_source_to_account(datastore, account, xml.decode())

    return bose_xml_str(xml_resp)


@app.delete("/marge/streaming/account/{account}/source/{source_id}", tags=["marge"])
async def delete_account_source(
    account: Annotated[str, Path(pattern=ACCOUNT_RE)],
    source_id: str,
    response: Response,
):
    remove_source_from_account(datastore, account, source_id)
    response.headers["method_name"] = "removeSource"
    response.headers["location"] = f"{settings.base_url}/marge/account/{account}/source/{source_id}"
    response.body = b""
    response.status_code = HTTPStatus.OK
    return response


@app.get("/bmx/registry/v1/services", response_model_exclude_none=True, tags=["bmx"])
def bmx_services() -> BmxResponse:

    with open("bmx_services.json", "r") as file:
        bmx_response_json = file.read()
        bmx_response_json = bmx_response_json.replace("{MEDIA_SERVER}", f"{settings.base_url}/media").replace(
            "{BMX_SERVER}", settings.base_url
        )
        # TODO:  we're sending askAgainAfter hardcoded, but that value actually
        # varies.
        bmx_response = BmxResponse.model_validate_json(bmx_response_json)
        return bmx_response


@app.get(
    "/bmx/tunein/v1/playback/station/{station_id}",
    response_model_exclude_none=True,
    tags=["bmx"],
)
def bmx_playback(station_id: str) -> BmxPlaybackResponse:
    # Podcast show IDs (p-prefix) need latest episode resolution
    if station_id.startswith('p'):
        try:
            import re as _re, json as _json
            from urllib.request import urlopen, Request
            browse_url = f"http://opml.radiotime.com/Tune.ashx?c=pbrowse&id={station_id}&render=json"
            browse = _json.loads(urlopen(browse_url, timeout=10).read().decode())
            episode_id = None
            for section in browse.get('body', []):
                for ep in section.get('children', [section]):
                    m = _re.search(r'id=(t\d+)', ep.get('URL', ''))
                    if m:
                        episode_id = m.group(1)
                        break
                if episode_id:
                    break
            if episode_id:
                resp = tunein_playback(episode_id)
                try:
                    raw_url = resp.audio.streamUrl
                    if raw_url and not raw_url.startswith('#'):
                        req = Request(raw_url, method='HEAD', headers={'User-Agent': 'Mozilla/5.0'})
                        with urlopen(req, timeout=15) as r:
                            final_url = r.url
                        if final_url and final_url != raw_url:
                            resp.audio.streamUrl = final_url
                            for s in (resp.audio.streams or []):
                                s.streamUrl = final_url
                except Exception as e:
                    print(f"[podcast_resolve] url resolve failed: {e}")
                return resp
        except Exception as e:
            print(f"[podcast_resolve] failed for {station_id}: {e}")
    return tunein_playback(station_id)


@app.get(
    "/bmx/tunein/v1/playback/episodes/{episode_id}",
    response_model_exclude_none=True,
    tags=["bmx"],
)
def bmx_podcast_info(episode_id: str, request: Request) -> BmxPodcastInfoResponse:
    encoded_name = request.query_params.get("encoded_name", "")
    return tunein_podcast_info(episode_id, encoded_name)


@app.get(
    "/bmx/tunein/v1/playback/episode/{episode_id}",
    response_model_exclude_none=True,
    tags=["bmx"],
)
def bmx_playback_podcast(episode_id: str, request: Request) -> BmxPlaybackResponse:
    return tunein_playback_podcast(episode_id)


@app.get(
    "/bmx/tunein/v1/navigate",
    response_model_exclude_none=True,
    tags=["bmx"],
)
@app.get(
    "/bmx/tunein/v1/navigate/{encoded_uri}",
    response_model_exclude_none=True,
    tags=["bmx"],
)
@app.get(
    "/bmx/tunein/v1/navigate/sub/{subsection}/{encoded_uri}",
    response_model_exclude_none=True,
    tags=["bmx"],
)
def bmx_tunein_navigate(
    encoded_uri: str = "",
    subsection: int | None = None,
) -> BmxNavResponse:
    return tunein_navigate_v1(encoded_uri, subsection)


@app.get(
    "/bmx/tunein/v1/navigate/profiles/{profile_type}/{program_id}/{encoded_uri}",
    response_model_exclude_none=True,
    tags=["bmx"],
)
def bmx_tunein_navigate_profile(
    encoded_uri: str = "",
    profile_type: str | None = None,
    program_id: str | None = None,
) -> BmxNavResponse:
    # the profile_type and program_id i think can be ignored in favor of the encoded_uri?
    return tunein_navigate_profile_v1(encoded_uri)


@app.get(
    "/bmx/tunein/v1/search",
    response_model_exclude_none=True,
    tags=["bmx"],
)
def bmx_tunein_search_v1(request: Request) -> BmxNavResponse:
    return tunein_search_v1(request.query_params.get("q", ""))


@app.get("/core02/svc-bmx-adapter-orion/prod/orion/station", tags=["bmx"])
def custom_stream_playback(request: Request) -> BmxPlaybackResponse:
    data = request.query_params.get("data", "")
    return play_custom_stream(data)


# BMX Orion alias -- Go registers this as POST, device may use GET or POST
@app.post("/bmx/orion/v1/playback/station/{data}", tags=["bmx"])
@app.get("/bmx/orion/v1/playback/station/{data}", tags=["bmx"])
def bmx_orion_playback(data: str) -> BmxPlaybackResponse:
    return play_custom_stream(data)


@app.get("/media/{filename}", tags=["bmx"])
def bmx_media_file(filename: str) -> FileResponse:
    sanitized_filename = "".join(x for x in filename if x.isalnum() or x == "." or x == "-" or x == "_")
    file_path = os.path.join("media", sanitized_filename)
    if os.path.isfile(file_path):
        return FileResponse(file_path)

    raise HTTPException(status_code=404, detail="not found")


@app.get("/updates/soundtouch", tags=["swupdate"])
@app.get("/marge/updates/soundtouch", tags=["swupdate"])
def sw_update() -> Response:
    with open("swupdate.xml", "r") as file:
        sw_update_response = file.read()
        response = Response(content=sw_update_response, media_type="application/xml")
        return response


def bose_xml_str(xml: ET.Element) -> str:
    # ET.tostring won't allow you to set standalone="yes"
    return_xml = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>{ET.tostring(xml, encoding="unicode")}'

    return return_xml


##############################################################################
# Root-level aliases (without /marge or /bmx prefix)
#
# The Go implementation registers every marge/bmx endpoint twice -- once
# under the prefix and once at the root.  This supports direct-domain
# calls where the speaker hits streaming.bose.com/accounts/... without
# the /marge path segment.
#
# We use FastAPI's add_api_route to point the alias paths at the same
# handler functions already defined above.
##############################################################################

# --- BMX root-level aliases ---
app.add_api_route("/registry/v1/services", bmx_services, methods=["GET"], tags=["bmx-alias"])
app.add_api_route(
    "/tunein/v1/playback/station/{station_id}",
    bmx_playback,
    methods=["GET"],
    tags=["bmx-alias"],
)
app.add_api_route(
    "/tunein/v1/playback/episodes/{episode_id}",
    bmx_podcast_info,
    methods=["GET"],
    tags=["bmx-alias"],
)
app.add_api_route(
    "/tunein/v1/playback/episode/{episode_id}",
    bmx_playback_podcast,
    methods=["GET"],
    tags=["bmx-alias"],
)
app.add_api_route(
    "/orion/v1/playback/station/{data}",
    bmx_orion_playback,
    methods=["GET", "POST"],
    tags=["bmx-alias"],
)

# --- Marge root-level aliases ---
app.add_api_route(
    "/streaming/sourceproviders",
    streamingsourceproviders,
    methods=["GET"],
    tags=["marge-alias"],
)
app.add_api_route(
    "/streaming/account/{account}/full",
    account_full,
    methods=["GET"],
    tags=["marge-alias"],
)
app.add_api_route("/streaming/support/power_on", power_on, methods=["POST"], tags=["marge-alias"])
app.add_api_route(
    "/streaming/device/{device}/streaming_token",
    streaming_token,
    methods=["GET"],
    tags=["marge-alias"],
)
app.add_api_route(
    "/streaming/account/{account}/device/{device}/presets",
    account_presets,
    methods=["GET"],
    tags=["marge-alias"],
)
app.add_api_route(
    "/streaming/account/{account}/device/{device}/preset/{preset_number}",
    put_account_preset,
    methods=["PUT"],
    tags=["marge-alias"],
)
app.add_api_route(
    "/streaming/account/{account}/device/{device}/recents",
    account_recents,
    methods=["GET"],
    tags=["marge-alias"],
)
app.add_api_route(
    "/streaming/account/{account}/provider_settings",
    account_provider_settings,
    methods=["GET"],
    tags=["marge-alias"],
)
app.add_api_route(
    "/streaming/software/update/account/{account}",
    software_update,
    methods=["GET"],
    tags=["marge-alias"],
)
app.add_api_route(
    "/streaming/account/{account}/device/{device}/recent",
    post_account_recent,
    methods=["POST"],
    tags=["marge-alias"],
)
app.add_api_route(
    "/streaming/account/{account}/device/",
    post_account_device,
    methods=["POST"],
    tags=["marge-alias"],
)
app.add_api_route(
    "/streaming/account/{account}/device/{device}",
    delete_account_device,
    methods=["DELETE"],
    tags=["marge-alias"],
)
app.add_api_route(
    "/streaming/support/customersupport",
    customer_support_upload,
    methods=["POST"],
    tags=["marge-alias"],
)
app.add_api_route(
    "/streaming/device_setting/account/{account}/device/{device}/device_settings",
    get_device_settings,
    methods=["GET"],
    tags=["marge-alias"],
)
app.add_api_route(
    "/streaming/device_setting/account/{account}/device/{device}/device_settings",
    update_device_settings,
    methods=["POST"],
    tags=["marge-alias"],
)
app.add_api_route(
    "/streaming/account/{account}/emailaddress",
    get_email_address,
    methods=["GET"],
    tags=["marge-alias"],
)

# --- Marge /accounts/ style aliases (gesellix/Bose-SoundTouch path format) ---
# The Go project registers these shorter paths alongside /streaming/account/ paths.
# Both path styles should work for maximum speaker firmware compatibility.
app.add_api_route(
    "/marge/accounts/{account}/full",
    account_full,
    methods=["GET"],
    tags=["marge-alias"],
)
app.add_api_route("/accounts/{account}/full", account_full, methods=["GET"], tags=["marge-alias"])
app.add_api_route(
    "/marge/accounts/{account}/devices/{device}/presets",
    account_presets,
    methods=["GET"],
    tags=["marge-alias"],
)
app.add_api_route(
    "/accounts/{account}/devices/{device}/presets",
    account_presets,
    methods=["GET"],
    tags=["marge-alias"],
)
app.add_api_route(
    "/marge/accounts/{account}/devices/{device}/presets/{preset_number}",
    put_account_preset,
    methods=["PUT"],
    tags=["marge-alias"],
)
app.add_api_route(
    "/accounts/{account}/devices/{device}/presets/{preset_number}",
    put_account_preset,
    methods=["PUT"],
    tags=["marge-alias"],
)
app.add_api_route(
    "/marge/accounts/{account}/devices/{device}/recents",
    account_recents,
    methods=["GET"],
    tags=["marge-alias"],
)
app.add_api_route(
    "/accounts/{account}/devices/{device}/recents",
    account_recents,
    methods=["GET"],
    tags=["marge-alias"],
)
app.add_api_route(
    "/marge/accounts/{account}/devices/{device}/recents",
    post_account_recent,
    methods=["POST"],
    tags=["marge-alias"],
)
app.add_api_route(
    "/accounts/{account}/devices/{device}/recents",
    post_account_recent,
    methods=["POST"],
    tags=["marge-alias"],
)
app.add_api_route(
    "/marge/accounts/{account}/devices",
    post_account_device,
    methods=["POST"],
    tags=["marge-alias"],
)
app.add_api_route(
    "/accounts/{account}/devices",
    post_account_device,
    methods=["POST"],
    tags=["marge-alias"],
)
app.add_api_route(
    "/marge/accounts/{account}/devices/{device}",
    delete_account_device,
    methods=["DELETE"],
    tags=["marge-alias"],
)
app.add_api_route(
    "/accounts/{account}/devices/{device}",
    delete_account_device,
    methods=["DELETE"],
    tags=["marge-alias"],
)

# --- Customer root-level aliases (already at /customer/..., no prefix to strip) ---
# These are already at root level, no aliases needed.


################## configuration ############


@app.get("/scan_recents", tags=["setup"])
def test_scan_recents():
    devices = get_bose_devices()
    recents = []
    for device in devices:
        recents.append(read_recents(hostname_for_device(device)))
    return recents


@app.get("/scan", tags=["setup"])
def scan_devices():
    """Unlikely to be used in production, but has been useful during development."""
    devices = get_bose_devices()
    device_infos = {}
    for device in devices:
        info_elem = ET.fromstring(read_device_info(hostname_for_device(device)))
        device_infos[device.udn] = {
            "device_id": info_elem.attrib.get("deviceID", ""),
            "name": info_elem.find("name").text,  # type: ignore
            "type": info_elem.find("type").text,  # type: ignore
            "marge URL": info_elem.find("margeURL").text,  # type: ignore
            "account": info_elem.find("margeAccountUUID").text,  # type: ignore
        }
    return device_infos


@app.post("/add_device/{device_id}", tags=["setup"])
def add_device_to_datastore(device_id: str):
    devices = get_bose_devices()
    for device in devices:
        info_elem = ET.fromstring(read_device_info(hostname_for_device(device)))
        if info_elem.attrib.get("deviceID", "") == device_id:
            success = add_device(device)
            return {device_id: success}


#####################################################################################
# include all routines for groups
app.include_router(get_groups_router(datastore))
app.include_router(get_groups_service_router(datastore))


#  include admin router
app.include_router(get_admin_router(datastore, speakers))

#  include miniapp router
app.include_router(get_miniapp_router(datastore, settings))

# Stub serviceAvailability endpoints - required for speaker to enable BMX/TuneIn
@app.get("/serviceAvailability", tags=["bmx"])
@app.get("/bmx/serviceAvailability", tags=["bmx"])
def service_availability():
    from fastapi.responses import Response
    xml = '''<?xml version="1.0" encoding="UTF-8" ?>
<serviceAvailability>
  <services>
    <service type="TUNEIN" isAvailable="true" />
    <service type="LOCAL_INTERNET_RADIO" isAvailable="true" />
    <service type="PANDORA" isAvailable="true" />
    <service type="AMAZON" isAvailable="true" />
    <service type="SPOTIFY" isAvailable="true" />
    <service type="AIRPLAY" isAvailable="true" />
    <service type="BMX" isAvailable="true" />
  </services>
</serviceAvailability>'''
    return Response(content=xml, media_type="application/xml")

# Additional serviceAvailability stub endpoints
@app.get("/bmx/servicesAvailability", tags=["bmx"])
@app.get("/bmx/registry/servicesAvailability", tags=["bmx"])
def bmx_services_availability():
    from fastapi.responses import Response
    xml = '''<?xml version="1.0" encoding="UTF-8" ?>
<serviceAvailability>
  <services>
    <service type="TUNEIN" isAvailable="true" />
    <service type="LOCAL_INTERNET_RADIO" isAvailable="true" />
    <service type="BMX" isAvailable="true" />
  </services>
</serviceAvailability>'''
    return Response(content=xml, media_type="application/xml")
#####################################################################################
#####################################################################################
# SoundCork Native API - Phase 1
# Unauthenticated REST endpoints for Home Assistant integration
# Proxies speaker commands through SoundCork without requiring session auth
#####################################################################################

import json as _json
import httpx as _httpx

_SPEAKER_PORT = 8090
_SPEAKER_TIMEOUT = 5.0


def _speaker_url(ip: str, path: str) -> str:
    return f"http://{ip}:{_SPEAKER_PORT}{path}"


def _speakers_from_file() -> list:
    """Load speakers from webui_speakers.json."""
    import os
    path = os.path.join(settings.data_dir, "webui_speakers.json")
    try:
        with open(path, "r") as f:
            return _json.load(f)
    except Exception:
        return []


async def _key_press(client: _httpx.AsyncClient, ip: str, key: str) -> _httpx.Response:
    """Send a key press followed by a key release as required by the Bose API spec."""
    headers = {"Content-Type": "application/xml"}
    press = f'<key state="press" sender="Gabbo">{key}</key>'.encode()
    release = f'<key state="release" sender="Gabbo">{key}</key>'.encode()
    await client.post(_speaker_url(ip, "/key"), content=press, headers=headers)
    return await client.post(_speaker_url(ip, "/key"), content=release, headers=headers)


# ---------------------------------------------------------------------------
# Speaker list
# ---------------------------------------------------------------------------

@app.get("/api/v1/speakers", tags=["soundcork-api"])
def api_list_speakers():
    """List all registered speakers."""
    return _speakers_from_file()


# ---------------------------------------------------------------------------
# Now Playing
# ---------------------------------------------------------------------------

@app.get("/api/v1/speakers/{ip}/now-playing", tags=["soundcork-api"])
async def api_now_playing(ip: str):
    """Get current now-playing state from a speaker, zone-aware.

    Bose firmware quirk (observed 2026-10-03): a zone SLAVE keeps the
    ContentItem/metadata of whatever it last selected itself (e.g. WMSE)
    even while it is audibly playing the zone master's stream. The
    official app papers over this by showing the master's now-playing on
    slaves; we do the same here so HA entities and every dashboard tile
    reflect what the speaker is actually playing. The slave's own
    deviceID is preserved in the returned XML so per-speaker consumers
    keep matching correctly.
    """
    try:
        async with _httpx.AsyncClient(timeout=_SPEAKER_TIMEOUT) as client:
            r = await client.get(_speaker_url(ip, "/nowPlaying"))
            content = r.content
            if r.status_code == 200 and b"STANDBY" not in content:
                try:
                    own_id = (re.search(rb'nowPlaying[^>]*deviceID="([^"]+)"', content) or [None, b""])[1]
                    zr = await client.get(_speaker_url(ip, "/getZone"))
                    zm = re.search(rb'<zone[^>]*master="([^"]+)"', zr.content)
                    zs = re.search(rb'senderIPAddress="([^"]+)"', zr.content)
                    if zm and zs and own_id and zm.group(1) != own_id:
                        master_ip = zs.group(1).decode()
                        mr = await client.get(_speaker_url(master_ip, "/nowPlaying"))
                        if mr.status_code == 200 and b"STANDBY" not in mr.content:
                            content = re.sub(
                                rb'(<nowPlaying[^>]*deviceID=")[^"]+(")',
                                rb"\g<1>" + own_id + rb"\g<2>",
                                mr.content,
                                count=1,
                            )
                except Exception:
                    pass  # zone lookup is best-effort; fall back to own state
            return Response(content=content, media_type="application/xml", status_code=r.status_code)
    except _httpx.ConnectError:
        raise HTTPException(status_code=503, detail=f"Cannot reach speaker at {ip}")
    except _httpx.TimeoutException:
        raise HTTPException(status_code=504, detail=f"Speaker at {ip} timed out")


# ---------------------------------------------------------------------------
# Presets
# ---------------------------------------------------------------------------

@app.get("/api/v1/speakers/{ip}/presets", tags=["soundcork-api"])
async def api_get_presets(ip: str):
    """Get current presets from a speaker."""
    try:
        async with _httpx.AsyncClient(timeout=_SPEAKER_TIMEOUT) as client:
            r = await client.get(_speaker_url(ip, "/presets"))
            return Response(content=r.content, media_type="application/xml", status_code=r.status_code)
    except _httpx.ConnectError:
        raise HTTPException(status_code=503, detail=f"Cannot reach speaker at {ip}")
    except _httpx.TimeoutException:
        raise HTTPException(status_code=504, detail=f"Speaker at {ip} timed out")


# ---------------------------------------------------------------------------
# Preset safety net
#
# The physical SoundTouch speaker keeps zero undo history: /storePreset
# just overwrites the slot. Any buggy client (HA card, integration, script)
# can silently wipe every preset on every speaker in one bad session, as
# happened on 2026-08-15. To make that a non-event instead of an outage:
#
#   - every store-preset write is preceded by an automatic, timestamped
#     snapshot of that speaker's CURRENT presets (best-effort, never blocks
#     the write)
#   - /presets/backups lists snapshots for one speaker
#   - /presets/restore rolls one speaker back to a snapshot (default: latest)
#   - /presets/restore-all recovers every registered speaker from the
#     account's baseline Presets.xml in one call (requires explicit confirm)
#   - /presets/snapshot-baseline lets a human deliberately promote a
#     speaker's current (verified-good) presets to become that baseline
# ---------------------------------------------------------------------------

import glob as _glob

_PRESET_BACKUP_DIR = os.path.join(settings.data_dir, "preset_backups")
_PRESET_BACKUP_KEEP = 30  # snapshots kept per speaker

# Older Bose SoundTouch firmware can hang its onboard HTTP daemon or
# silently drop/corrupt a storePreset write when hit with a burst of
# writes with no gap between them. Observed 2026-08-15: an unthrottled
# restore-all wiped 5 of 8 speakers and hard-hung 2 more (had to be
# power-cycled). These pacing delays are deliberately conservative.
_PRESET_WRITE_PACING_SECONDS = 0.6
_PRESET_SPEAKER_PACING_SECONDS = 1.0

import base64 as _base64

def _wrap_local_internet_radio_content_item(preset_elem: ET.Element) -> None:
    """
    Root cause (found 2026-08-15): Presets.xml and on-device preset backups
    store LOCAL_INTERNET_RADIO/stationurl presets with a bare external
    stream URL in `location` (e.g. https://wmse.streamguys1.com/wmseliveaac).
    That is NOT what the speaker firmware actually needs to stream
    reliably -- the webui's own "Save Preset" flow (app.js, ~line 1487)
    instead points `location` back at soundcork's own
    /core02/svc-bmx-adapter-orion/prod/orion/station proxy, with
    {name, imageUrl, streamUrl} base64-encoded as the `data` query param.
    A preset written with the bare URL still returns 200 from storePreset
    and looks structurally fine, but the speaker never reports
    playStatus=PLAY_STATE for it and does not reliably play.

    api_restore_preset_backup / api_restore_all_from_baseline used to push
    the raw Presets.xml/backups location straight through, skipping this
    wrapping entirely -- that's what silently broke playback for every
    preset those two endpoints touched tonight. This wraps LOCAL_INTERNET_
    RADIO/stationurl presets the same way the webui does, in place, before
    the preset is sent to storePreset. No-op for anything already wrapped
    or any other source type.
    """
    content_item = preset_elem.find("ContentItem")
    if content_item is None:
        return
    if content_item.attrib.get("source") != "LOCAL_INTERNET_RADIO":
        return
    if content_item.attrib.get("type") != "stationurl":
        return
    location = content_item.attrib.get("location", "")
    if not location or "/core02/svc-bmx-adapter-orion/" in location:
        return
    item_name = (content_item.findtext("itemName") or "").strip()
    container_art = (content_item.findtext("containerArt") or "").strip()
    payload = _base64.b64encode(
        _json.dumps({"name": item_name, "imageUrl": container_art, "streamUrl": location}).encode()
    ).decode()
    content_item.set(
        "location",
        f"{settings.base_url}/core02/svc-bmx-adapter-orion/prod/orion/station?data={payload}",
    )


_STORE_PRESET_GLOBAL_LOCK = asyncio.Lock()
_STORE_PRESET_MIN_INTERVAL_SECONDS = 1.0
_last_store_preset_at = {"t": 0.0}


async def _pace_store_preset_globally():
    """
    Serialize + pace EVERY storePreset write through one choke point,
    regardless of which speaker it targets or which client issued it
    (webui, HA integration, lovelace card, our own restore endpoints).

    Root-caused twice on 2026-08-15: an unpaced burst of storePreset
    writes -- even just one write per speaker, fired back-to-back across
    *different* speakers with no gap -- corrupted TheDeck's and Seven's
    entire onboard preset stores (not just the slot being written). The
    restore endpoints already paced their own internal writes, but
    api_store_preset (used directly by the webui, HA's store_preset_radio/
    store_preset_tunein services, and the "TuneIn Preset Editor" lovelace
    card's per-speaker save loop) had no pacing at all -- so any of those
    callers broadcasting a save to "All" speakers could still reproduce
    the original incident. This makes api_store_preset itself safe no
    matter what calls it, instead of relying on every caller to pace
    itself correctly.
    """
    async with _STORE_PRESET_GLOBAL_LOCK:
        loop = asyncio.get_event_loop()
        now = loop.time()
        wait = _STORE_PRESET_MIN_INTERVAL_SECONDS - (now - _last_store_preset_at["t"])
        if wait > 0:
            await asyncio.sleep(wait)
        _last_store_preset_at["t"] = loop.time()


def _preset_backup_dir_for(ip: str) -> str:
    d = os.path.join(_PRESET_BACKUP_DIR, ip.replace(":", "_"))
    os.makedirs(d, exist_ok=True)
    return d


async def _snapshot_speaker_presets(client: "_httpx.AsyncClient", ip: str):
    """Best-effort: fetch a speaker's current presets and write a timestamped
    backup before we let a write touch it. Never raises."""
    try:
        r = await client.get(_speaker_url(ip, "/presets"), timeout=_SPEAKER_TIMEOUT)
        if r.status_code != 200 or not r.content.strip():
            return None
        ts = datetime.utcnow().strftime("%Y%m%dT%H%M%S.%fZ")
        d = _preset_backup_dir_for(ip)
        backup_path = os.path.join(d, f"{ts}.xml")
        with open(backup_path, "wb") as f:
            f.write(r.content)
        files = sorted(_glob.glob(os.path.join(d, "*.xml")))
        for old in files[:-_PRESET_BACKUP_KEEP]:
            try:
                os.remove(old)
            except OSError:
                pass
        return backup_path
    except Exception as e:
        logger.warning(f"preset backup failed for {ip}: {e}")
        return None


@app.post("/api/v1/speakers/{ip}/store-preset", tags=["soundcork-api"])
async def api_store_preset(ip: str, request: Request):
    """
    Store a preset on a speaker.
    Body: <preset id="1"><ContentItem source="TUNEIN" ...>...</ContentItem></preset>

    Snapshots the speaker's current presets to disk first - see
    GET /api/v1/speakers/{ip}/presets/backups and
    POST /api/v1/speakers/{ip}/presets/restore.
    """
    body = await request.body()
    await _pace_store_preset_globally()
    try:
        async with _httpx.AsyncClient(timeout=_SPEAKER_TIMEOUT) as client:
            await _snapshot_speaker_presets(client, ip)
            r = await client.post(
                _speaker_url(ip, "/storePreset"),
                content=body,
                headers={"Content-Type": "application/xml"},
            )
            return Response(content=r.content, media_type="application/xml", status_code=r.status_code)
    except _httpx.ConnectError:
        raise HTTPException(status_code=503, detail=f"Cannot reach speaker at {ip}")
    except _httpx.TimeoutException:
        raise HTTPException(status_code=504, detail=f"Speaker at {ip} timed out")


@app.get("/api/v1/speakers/{ip}/presets/backups", tags=["soundcork-api"])
def api_list_preset_backups(ip: str):
    """List available preset snapshots for a speaker, oldest first."""
    d = _preset_backup_dir_for(ip)
    files = sorted(_glob.glob(os.path.join(d, "*.xml")))
    out = []
    for f in files:
        ts = os.path.basename(f)[:-4]
        try:
            with open(f, "rb") as fh:
                root = ET.fromstring(fh.read())
            names = [
                {
                    "id": p.attrib.get("id"),
                    "name": (p.find("ContentItem").findtext("itemName") or "")
                    if p.find("ContentItem") is not None
                    else "",
                }
                for p in root.findall("preset")
            ]
        except Exception:
            names = []
        out.append({"timestamp": ts, "presets": names})
    return {"ip": ip, "backups": out}


@app.post("/api/v1/speakers/{ip}/presets/restore", tags=["soundcork-api"])
async def api_restore_preset_backup(ip: str, request: Request):
    """
    Roll a speaker's presets back to a snapshot.
    Body (optional JSON): {"timestamp": "<id from .../presets/backups>"}
    Omit the body (or timestamp) to restore the most recent snapshot.
    """
    body = await request.body()
    timestamp = None
    if body:
        try:
            timestamp = _json.loads(body).get("timestamp")
        except Exception:
            timestamp = None

    d = _preset_backup_dir_for(ip)
    files = sorted(_glob.glob(os.path.join(d, "*.xml")))
    if not files:
        raise HTTPException(status_code=404, detail=f"No backups found for {ip}")
    if timestamp:
        matches = [f for f in files if os.path.basename(f) == f"{timestamp}.xml"]
        if not matches:
            raise HTTPException(status_code=404, detail=f"Backup {timestamp} not found for {ip}")
        target = matches[0]
    else:
        target = files[-1]

    with open(target, "rb") as f:
        root = ET.fromstring(f.read())

    results = []
    try:
        async with _httpx.AsyncClient(timeout=_SPEAKER_TIMEOUT) as client:
            for preset in root.findall("preset"):
                _wrap_local_internet_radio_content_item(preset)
                preset_xml = ET.tostring(preset, encoding="unicode")
                r = await client.post(
                    _speaker_url(ip, "/storePreset"),
                    content=preset_xml.encode(),
                    headers={"Content-Type": "application/xml"},
                )
                results.append({"id": preset.attrib.get("id"), "status": r.status_code})
                # Older SoundTouch firmware can hang or corrupt onboard presets
                # when hit with a burst of storePreset writes with no gap
                # between them (observed 2026-08-15: rapid restore writes
                # wiped 5 speakers and hard-hung 2 more). Pace writes to a
                # single speaker so its firmware can keep up.
                await asyncio.sleep(_PRESET_WRITE_PACING_SECONDS)
    except _httpx.ConnectError:
        raise HTTPException(status_code=503, detail=f"Cannot reach speaker at {ip}")
    except _httpx.TimeoutException:
        raise HTTPException(status_code=504, detail=f"Speaker at {ip} timed out")

    return {"ip": ip, "restored_from": os.path.basename(target), "results": results}


@app.post("/api/v1/presets/restore-all", tags=["soundcork-api"])
async def api_restore_all_from_baseline(request: Request):
    """
    Recover EVERY registered speaker's presets from the account's baseline
    Presets.xml (the same source marge serves on power-on). This is the
    "something wiped everyone's presets" button.

    Requires {"confirm": true} in the JSON body.
    """
    body = await request.body()
    try:
        payload = _json.loads(body) if body else {}
    except Exception:
        payload = {}
    if not payload.get("confirm"):
        raise HTTPException(
            status_code=400,
            detail="Refusing to restore all speakers without {'confirm': true} in the request body.",
        )

    accounts = datastore.list_accounts()
    if not accounts:
        raise HTTPException(status_code=404, detail="No accounts found")
    account = accounts[0]
    presets_path = os.path.join(settings.data_dir, str(account), "Presets.xml")
    if not os.path.exists(presets_path):
        raise HTTPException(status_code=404, detail=f"No baseline Presets.xml for account {account}")

    root = ET.parse(presets_path).getroot()
    preset_elems = root.findall("preset")
    if not preset_elems:
        raise HTTPException(status_code=422, detail="Baseline Presets.xml has no presets")

    speakers = _speakers_from_file()
    results = []
    async with _httpx.AsyncClient(timeout=_SPEAKER_TIMEOUT) as client:
        for sp in speakers:
            ip = sp.get("ipAddress")
            if not ip:
                continue
            await _snapshot_speaker_presets(client, ip)
            for preset in preset_elems:
                _wrap_local_internet_radio_content_item(preset)
                preset_xml = ET.tostring(preset, encoding="unicode")
                try:
                    r = await client.post(
                        _speaker_url(ip, "/storePreset"),
                        content=preset_xml.encode(),
                        headers={"Content-Type": "application/xml"},
                    )
                    status = r.status_code
                except Exception as e:
                    status = f"error: {e}"
                results.append(
                    {"speaker": sp.get("name"), "ip": ip, "preset": preset.attrib.get("id"), "status": status}
                )
                # See note in api_restore_preset_backup: pace writes so we
                # don't overload a single speaker's firmware.
                await asyncio.sleep(_PRESET_WRITE_PACING_SECONDS)
            # Extra breathing room before moving on to the next physical
            # speaker.
            await asyncio.sleep(_PRESET_SPEAKER_PACING_SECONDS)
    ok = sum(1 for r in results if r["status"] == 200)
    return {
        "account": account,
        "baseline": os.path.basename(presets_path),
        "total": len(results),
        "ok": ok,
        "results": results,
    }


@app.post("/api/v1/presets/snapshot-baseline", tags=["soundcork-api"])
async def api_snapshot_baseline(request: Request):
    """
    Deliberately promote one speaker's CURRENT presets to become the new
    account baseline Presets.xml (used by /presets/restore-all and by the
    marge power-on preset sync). Use this only after manually confirming
    that speaker's presets are correct - the previous baseline is itself
    backed up first, under preset_backups/_baseline_history/.

    Body (JSON): {"ip": "192.168.1.xxx"}
    """
    try:
        payload = _json.loads(await request.body())
    except Exception:
        payload = {}
    ip = payload.get("ip")
    if not ip:
        raise HTTPException(status_code=400, detail="Body must include {'ip': '<speaker ip>'}")

    try:
        async with _httpx.AsyncClient(timeout=_SPEAKER_TIMEOUT) as client:
            r = await client.get(_speaker_url(ip, "/presets"))
    except _httpx.ConnectError:
        raise HTTPException(status_code=503, detail=f"Cannot reach speaker at {ip}")
    if r.status_code != 200 or not r.content.strip():
        raise HTTPException(status_code=502, detail=f"Could not read presets from {ip}")

    accounts = datastore.list_accounts()
    if not accounts:
        raise HTTPException(status_code=404, detail="No accounts found")
    account = accounts[0]
    presets_path = os.path.join(settings.data_dir, str(account), "Presets.xml")

    if os.path.exists(presets_path):
        ts = datetime.utcnow().strftime("%Y%m%dT%H%M%S.%fZ")
        baseline_backup_dir = os.path.join(_PRESET_BACKUP_DIR, "_baseline_history")
        os.makedirs(baseline_backup_dir, exist_ok=True)
        with open(presets_path, "rb") as src, open(
            os.path.join(baseline_backup_dir, f"{ts}.xml"), "wb"
        ) as dst:
            dst.write(src.read())

    with open(presets_path, "wb") as f:
        f.write(r.content)

    return {"account": account, "baseline_updated_from": ip, "baseline_path": presets_path}


# ---------------------------------------------------------------------------
# Select / Play
# ---------------------------------------------------------------------------

@app.post("/api/v1/speakers/{ip}/select", tags=["soundcork-api"])
async def api_select(ip: str, request: Request):
    """
    Play a content item on a speaker.
    Body: <ContentItem source="TUNEIN" type="stationurl" location="..." isPresetable="true"></ContentItem>
    """
    body = await request.body()
    try:
        async with _httpx.AsyncClient(timeout=_SPEAKER_TIMEOUT) as client:
            r = await client.post(
                _speaker_url(ip, "/select"),
                content=body,
                headers={"Content-Type": "application/xml"},
            )
            return Response(content=r.content, media_type="application/xml", status_code=r.status_code)
    except _httpx.ConnectError:
        raise HTTPException(status_code=503, detail=f"Cannot reach speaker at {ip}")
    except _httpx.TimeoutException:
        raise HTTPException(status_code=504, detail=f"Speaker at {ip} timed out")


# ---------------------------------------------------------------------------
# Volume
# ---------------------------------------------------------------------------

@app.get("/api/v1/speakers/{ip}/volume", tags=["soundcork-api"])
async def api_get_volume(ip: str):
    """Get current volume from a speaker."""
    try:
        async with _httpx.AsyncClient(timeout=_SPEAKER_TIMEOUT) as client:
            r = await client.get(_speaker_url(ip, "/volume"))
            return Response(content=r.content, media_type="application/xml", status_code=r.status_code)
    except _httpx.ConnectError:
        raise HTTPException(status_code=503, detail=f"Cannot reach speaker at {ip}")
    except _httpx.TimeoutException:
        raise HTTPException(status_code=504, detail=f"Speaker at {ip} timed out")


@app.post("/api/v1/speakers/{ip}/volume", tags=["soundcork-api"])
async def api_set_volume(ip: str, request: Request):
    """Set volume on a speaker. Body: <volume>25</volume>"""
    body = await request.body()
    try:
        async with _httpx.AsyncClient(timeout=_SPEAKER_TIMEOUT) as client:
            r = await client.post(
                _speaker_url(ip, "/volume"),
                content=body,
                headers={"Content-Type": "application/xml"},
            )
            return Response(content=r.content, media_type="application/xml", status_code=r.status_code)
    except _httpx.ConnectError:
        raise HTTPException(status_code=503, detail=f"Cannot reach speaker at {ip}")
    except _httpx.TimeoutException:
        raise HTTPException(status_code=504, detail=f"Speaker at {ip} timed out")


# ---------------------------------------------------------------------------
# Power
# ---------------------------------------------------------------------------

@app.post("/api/v1/speakers/{ip}/power", tags=["soundcork-api"])
async def api_power(ip: str):
    """Toggle power on a speaker (press + release POWER key)."""
    try:
        async with _httpx.AsyncClient(timeout=_SPEAKER_TIMEOUT) as client:
            r = await _key_press(client, ip, "POWER")
            return Response(content=r.content, media_type="application/xml", status_code=r.status_code)
    except _httpx.ConnectError:
        raise HTTPException(status_code=503, detail=f"Cannot reach speaker at {ip}")
    except _httpx.TimeoutException:
        raise HTTPException(status_code=504, detail=f"Speaker at {ip} timed out")


@app.post("/api/v1/speakers/{ip}/power-on", tags=["soundcork-api"])
async def api_power_on(ip: str):
    """Power on a speaker -- only sends key if currently in STANDBY."""
    try:
        async with _httpx.AsyncClient(timeout=_SPEAKER_TIMEOUT) as client:
            r = await client.get(_speaker_url(ip, "/nowPlaying"))
            xml = ET.fromstring(r.content)
            if xml.attrib.get("source", "") == "STANDBY":
                r = await _key_press(client, ip, "POWER")
            return Response(content=r.content, media_type="application/xml", status_code=r.status_code)
    except _httpx.ConnectError:
        raise HTTPException(status_code=503, detail=f"Cannot reach speaker at {ip}")
    except _httpx.TimeoutException:
        raise HTTPException(status_code=504, detail=f"Speaker at {ip} timed out")


@app.post("/api/v1/speakers/{ip}/power-off", tags=["soundcork-api"])
async def api_power_off(ip: str):
    """Power off a speaker -- only sends key if not already in STANDBY."""
    try:
        async with _httpx.AsyncClient(timeout=_SPEAKER_TIMEOUT) as client:
            r = await client.get(_speaker_url(ip, "/nowPlaying"))
            xml = ET.fromstring(r.content)
            if xml.attrib.get("source", "") != "STANDBY":
                r = await _key_press(client, ip, "POWER")
            return Response(content=r.content, media_type="application/xml", status_code=r.status_code)
    except _httpx.ConnectError:
        raise HTTPException(status_code=503, detail=f"Cannot reach speaker at {ip}")
    except _httpx.TimeoutException:
        raise HTTPException(status_code=504, detail=f"Speaker at {ip} timed out")


# ---------------------------------------------------------------------------
# Generic key endpoint (press + release)
# ---------------------------------------------------------------------------

@app.post("/api/v1/speakers/{ip}/key/{key_value}", tags=["soundcork-api"])
async def api_key(ip: str, key_value: str):
    """
    Send a key press + release to a speaker.
    Valid values: PLAY, PAUSE, STOP, POWER, MUTE, VOLUME_UP, VOLUME_DOWN,
    PREV_TRACK, NEXT_TRACK, PRESET_1 through PRESET_6, etc.
    """
    try:
        async with _httpx.AsyncClient(timeout=_SPEAKER_TIMEOUT) as client:
            r = await _key_press(client, ip, key_value.upper())
            return Response(content=r.content, media_type="application/xml", status_code=r.status_code)
    except _httpx.ConnectError:
        raise HTTPException(status_code=503, detail=f"Cannot reach speaker at {ip}")
    except _httpx.TimeoutException:
        raise HTTPException(status_code=504, detail=f"Speaker at {ip} timed out")


# ---------------------------------------------------------------------------
# TuneIn Search
# ---------------------------------------------------------------------------

@app.get("/api/v1/tunein/search", tags=["soundcork-api"])
async def api_tunein_search(q: str):
    """Search TuneIn -- returns stations and podcasts."""
    url = f"https://opml.radiotime.com/search.ashx?query={q}&render=json&include=podcasts"
    try:
        async with _httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(url)
            return Response(content=r.content, media_type=r.headers.get("content-type", "application/json"), status_code=r.status_code)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"TuneIn search failed: {str(e)}")


@app.get("/api/v1/tunein/describe", tags=["soundcork-api"])
async def api_tunein_describe(id: str):
    """Get details for a specific TuneIn station/podcast by guide ID (e.g. s23452)."""
    url = f"https://opml.radiotime.com/describe.ashx?id={id}&render=json"
    try:
        async with _httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(url)
            return Response(content=r.content, media_type=r.headers.get("content-type", "application/json"), status_code=r.status_code)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"TuneIn describe failed: {str(e)}")


# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------

@app.get("/api/v1/speakers/{ip}/sources", tags=["soundcork-api"])
async def api_get_sources(ip: str):
    """Get available sources from a speaker."""
    try:
        async with _httpx.AsyncClient(timeout=_SPEAKER_TIMEOUT) as client:
            r = await client.get(_speaker_url(ip, "/sources"))
            return Response(content=r.content, media_type="application/xml", status_code=r.status_code)
    except _httpx.ConnectError:
        raise HTTPException(status_code=503, detail=f"Cannot reach speaker at {ip}")
    except _httpx.TimeoutException:
        raise HTTPException(status_code=504, detail=f"Speaker at {ip} timed out")

# ---------------------------------------------------------------------------
# Recents
# ---------------------------------------------------------------------------

@app.get("/api/v1/speakers/{ip}/recents", tags=["soundcork-api"])
async def api_get_recents(ip: str):
    """Get recently played items from a speaker."""
    try:
        async with _httpx.AsyncClient(timeout=_SPEAKER_TIMEOUT) as client:
            r = await client.get(_speaker_url(ip, "/recents"))
            return Response(content=r.content, media_type="application/xml", status_code=r.status_code)
    except _httpx.ConnectError:
        raise HTTPException(status_code=503, detail=f"Cannot reach speaker at {ip}")
    except _httpx.TimeoutException:
        raise HTTPException(status_code=504, detail=f"Speaker at {ip} timed out")


# ---------------------------------------------------------------------------
# Pandora station discovery
# Reads SoundCork stored Recents.xml (all-time history) rather than
# the live speaker recents endpoint (limited recent buffer).
# Returns deduplicated Pandora stations across all known accounts.
# ---------------------------------------------------------------------------

@app.get("/api/v1/pandora/stations", tags=["soundcork-api"])
async def api_pandora_stations():
    """
    Return all unique Pandora stations from both:
    1. SoundCork stored Recents.xml files (historical)
    2. Live recents from all registered speakers (most recent plays)
    Merges and deduplicates by location ID.
    """
    import glob
    import xml.etree.ElementTree as _ET

    stations: dict = {}  # key: location, value: station dict

    def _parse_recents_xml(xml_text: str) -> None:
        try:
            root = _ET.fromstring(xml_text)
            for recent in root.findall("recent"):
                ci = recent.find("contentItem")
                if ci is None:
                    continue
                if ci.attrib.get("source") != "PANDORA":
                    continue
                location = ci.attrib.get("location", "")
                if not location:
                    continue
                name_elem = ci.find("itemName")
                art_elem = ci.find("containerArt")
                name = name_elem.text if name_elem is not None and name_elem.text else ""
                art = art_elem.text if art_elem is not None and art_elem.text else ""
                # Only add if not seen, or if this entry has better data (name/art)
                if location not in stations or (not stations[location]["name"] and name):
                    stations[location] = {
                        "name": name or "Pandora Station",
                        "art": art,
                        "location": location,
                        "sourceAccount": ci.attrib.get("sourceAccount", ""),
                    }
                elif location in stations and not stations[location]["art"] and art:
                    stations[location]["art"] = art
        except Exception as e:
            logger.debug("Failed to parse recents XML: %s", e)

    # 1. Load from SoundCork stored Recents.xml files
    pattern = os.path.join(settings.data_dir, "*/Recents.xml")
    for recents_path in glob.glob(pattern):
        try:
            with open(recents_path, "r", encoding="utf-8", errors="ignore") as f:
                _parse_recents_xml(f.read())
        except Exception as e:
            logger.warning("Failed to read recents file %s: %s", recents_path, e)

    # 2. Fetch live recents from all registered speakers
    speakers = _speakers_from_file()
    async with _httpx.AsyncClient(timeout=_SPEAKER_TIMEOUT) as client:
        for speaker in speakers:
            ip = speaker.get("ipAddress", "")
            if not ip:
                continue
            try:
                r = await client.get(_speaker_url(ip, "/recents"))
                _parse_recents_xml(r.text)
            except Exception as e:
                logger.debug("Failed to fetch live recents from %s: %s", ip, e)

    # Group by account
    by_account: dict = {}
    for station in stations.values():
        acct = station["sourceAccount"]
        if acct not in by_account:
            by_account[acct] = []
        by_account[acct].append(station)

    return {"stations": list(stations.values()), "by_account": by_account}


# ---------------------------------------------------------------------------
# Zone management
# Create/clear Bose speaker zones for synchronized multi-room playback
# ---------------------------------------------------------------------------

@app.post("/api/v1/zone/set", tags=["soundcork-api"])
async def api_zone_set(request: Request):
    """
    Create a speaker zone for synchronized playback.
    The first speaker becomes master; others become slaves.
    Body JSON:
    {
      "master_ip": "192.168.1.228",
      "master_device_id": "A0F6FD743B41",
      "slaves": [
        {"ip": "192.168.1.41", "device_id": "587A6274B5C4"},
        ...
      ]
    }
    """
    body = await request.json()
    master_ip = body["master_ip"]
    master_device_id = body["master_device_id"]
    slaves = body.get("slaves", [])

    members = "".join(
        f'<member ipaddress="{s["ip"]}">{s["device_id"]}</member>'
        for s in slaves
    )
    zone_xml = (
        f'<zone master="{master_device_id}" senderIPAddress="{master_ip}">'
        f"{members}"
        f"</zone>"
    )

    try:
        async with _httpx.AsyncClient(timeout=_SPEAKER_TIMEOUT) as client:
            r = await client.post(
                _speaker_url(master_ip, "/setZone"),
                content=zone_xml.encode(),
                headers={"Content-Type": "application/xml"},
            )
            return Response(content=r.content, media_type="application/xml", status_code=r.status_code)
    except _httpx.ConnectError:
        raise HTTPException(status_code=503, detail=f"Cannot reach master speaker at {master_ip}")
    except _httpx.TimeoutException:
        raise HTTPException(status_code=504, detail=f"Master speaker at {master_ip} timed out")


@app.post("/api/v1/zone/clear/{ip}", tags=["soundcork-api"])
async def api_zone_clear(ip: str):
    """
    Clear/dissolve the zone on a master speaker.
    Sends setZone with no members, returning the speaker to standalone mode.
    Requires the device_id query parameter.
    """
    # Fetch device ID from stored DeviceInfo
    device_id = None
    for speaker in _speakers_from_file():
        if speaker.get("ipAddress") == ip:
            device_id = speaker.get("deviceId")
            break

    if not device_id:
        raise HTTPException(status_code=404, detail=f"Speaker {ip} not found in registry")

    zone_xml = f'<zone master="{device_id}" senderIPAddress="{ip}"></zone>'

    try:
        async with _httpx.AsyncClient(timeout=_SPEAKER_TIMEOUT) as client:
            r = await client.post(
                _speaker_url(ip, "/setZone"),
                content=zone_xml.encode(),
                headers={"Content-Type": "application/xml"},
            )
            return Response(content=r.content, media_type="application/xml", status_code=r.status_code)
    except _httpx.ConnectError:
        raise HTTPException(status_code=503, detail=f"Cannot reach speaker at {ip}")
    except _httpx.TimeoutException:
        raise HTTPException(status_code=504, detail=f"Speaker at {ip} timed out")


# ---------------------------------------------------------------------------
# TuneIn podcast browsing, favorites, and playback
#
# Playback deliberately does NOT hand the speaker a TUNEIN-source
# ContentItem (location="/v1/playback/station/{id}"): that routes through
# the speaker's own TuneIn client against Bose's shut-down backend and
# fails more often than it works. Instead the real stream URL is resolved
# from TuneIn's OPML API, the multi-hop redirect chain (podtrac/pdst/
# pscrb/...) is pre-followed because SoundTouch 10 firmware chokes on it,
# and the final URL is played through the same LOCAL_INTERNET_RADIO orion
# wrap the preset system uses (see _wrap_local_internet_radio_content_item).
# Verified on hardware 2026-10-01: The Deck reached PLAY_STATE in under
# 2 seconds for a The Daily episode routed this way.
# ---------------------------------------------------------------------------

from urllib.parse import quote as _urlquote
from xml.sax.saxutils import escape as _xml_escape, quoteattr as _xml_quoteattr

# Per-provider favorite stores. "tunein" keeps the original filename so
# existing favorites survive; ids are TuneIn guide ids for tunein and
# provider-native slugs/ids for the rest.
_FAVORITE_PROVIDERS = {
    "tunein": r"[pst]\d+",
    "pushkin": r"[a-z0-9-]{1,80}",
    "iheart": r"[A-Za-z0-9_-]{1,80}",
    "spotify": r"[A-Za-z0-9:_-]{1,120}",
}


def _favorites_path(provider: str) -> str:
    if provider == "tunein":
        return os.path.join(settings.data_dir, "podcast_favorites.json")
    return os.path.join(settings.data_dir, f"podcast_favorites_{provider}.json")


def _check_favorites_provider(provider: str) -> str:
    if provider not in _FAVORITE_PROVIDERS:
        raise HTTPException(status_code=400, detail=f"provider must be one of {sorted(_FAVORITE_PROVIDERS)}")
    return provider


def _load_podcast_favorites(provider: str = "tunein") -> list:
    try:
        with open(_favorites_path(provider), "r") as f:
            favs = _json.load(f)
            return favs if isinstance(favs, list) else []
    except Exception:
        return []


def _save_podcast_favorites(favs: list, provider: str = "tunein") -> None:
    with open(_favorites_path(provider), "w") as f:
        _json.dump(favs, f, indent=2)


@app.get("/api/v1/podcasts/favorites", tags=["soundcork-api"])
async def api_podcast_favorites(provider: str = "tunein"):
    """List favorites for a provider (tunein default, pushkin, iheart)."""
    return {"favorites": _load_podcast_favorites(_check_favorites_provider(provider))}


@app.post("/api/v1/podcasts/favorites", tags=["soundcork-api"])
async def api_podcast_favorite_add(request: Request):
    """Favorite a show/station/episode. Body: {guide_id, name, image?, provider?}."""
    body = await request.json()
    provider = _check_favorites_provider((body.get("provider") or "tunein").strip())
    guide_id = (body.get("guide_id") or "").strip()
    name = (body.get("name") or "").strip()
    if not re.fullmatch(_FAVORITE_PROVIDERS[provider], guide_id) or not name:
        raise HTTPException(status_code=400, detail=f"valid {provider} guide_id and name are required")
    favs = [f for f in _load_podcast_favorites(provider) if f.get("guide_id") != guide_id]
    favs.append({"guide_id": guide_id, "name": name, "image": (body.get("image") or "").strip()})
    _save_podcast_favorites(favs, provider)
    return {"favorites": favs}


@app.delete("/api/v1/podcasts/favorites/{guide_id}", tags=["soundcork-api"])
async def api_podcast_favorite_delete(guide_id: str, provider: str = "tunein"):
    """Remove a favorite by id (provider query param, tunein default)."""
    provider = _check_favorites_provider(provider)
    favs = [f for f in _load_podcast_favorites(provider) if f.get("guide_id") != guide_id]
    _save_podcast_favorites(favs, provider)
    return {"favorites": favs}


@app.get("/api/v1/tunein/episodes", tags=["soundcork-api"])
async def api_tunein_episodes(id: str):
    """Recent episodes for a TuneIn podcast show (guide id like p952868).

    TuneIn nests the ~50 most recent episodes under body[0].children
    (key="topics"), NOT directly in body.
    """
    if not re.fullmatch(r"p\d+", id):
        raise HTTPException(status_code=400, detail="id must be a podcast show guide id like p952868")
    try:
        async with _httpx.AsyncClient(timeout=10.0, headers={"User-Agent": "Mozilla/5.0"}) as client:
            r = await client.get(f"https://opml.radiotime.com/Tune.ashx?c=pbrowse&id={id}&render=json")
            data = r.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"TuneIn episode list failed: {e}")
    episodes = []
    for section in data.get("body", []):
        for child in section.get("children", []):
            if child.get("item") != "topic" or not child.get("guide_id"):
                continue
            episodes.append(
                {
                    "guide_id": child["guide_id"],
                    "title": child.get("text", ""),
                    "date": child.get("subtext", ""),
                    "duration_seconds": child.get("topic_duration"),
                    "image": child.get("image", ""),
                }
            )
    return {"show_id": id, "episodes": episodes}


_TUNEIN_POPULAR_TTL_SECONDS = 6 * 3600.0
_tunein_popular_cache = {"shows": None, "at": 0.0}


@app.get("/api/v1/tunein/popular", tags=["soundcork-api"])
async def api_tunein_popular():
    """Popular podcast shows, from tunein.com's own podcasts-page rails.

    The OPML API has no global popular-podcasts endpoint (checked
    2026-10-03: Browse c=popular returns radio stations, and the web
    rail collection ids come back empty through Browse.ashx), so this
    reads the web app's INITIAL_STATE JSON -- preferring the "Top
    Podcasts in Your Area" rail -- cached 6h.
    """
    loop = asyncio.get_event_loop()
    if _tunein_popular_cache["shows"] and loop.time() - _tunein_popular_cache["at"] < _TUNEIN_POPULAR_TTL_SECONDS:
        return {"shows": _tunein_popular_cache["shows"]}
    try:
        async with _httpx.AsyncClient(
            timeout=20.0, follow_redirects=True,
            headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"},
        ) as client:
            r = await client.get("https://tunein.com/podcasts/")
            html = r.text
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"tunein.com fetch failed: {e}")
    m = re.search(r"window\.INITIAL_STATE\s*=\s*(\{.*?\});?\s*</script>", html, re.S)
    if not m:
        raise HTTPException(status_code=502, detail="tunein.com page format changed (no INITIAL_STATE)")
    try:
        state = _json.loads(m.group(1))
        containers = state["categories"]["c100000088"]["containers"]
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"tunein.com page parse failed: {e}")

    def rail_shows(container):
        out = []
        for child in container.get("children", []):
            gid = child.get("guideId") or ""
            name = child.get("title") or (child.get("seoInfo") or {}).get("title") or ""
            if gid.startswith("p") and name:
                out.append({"guide_id": gid, "name": name, "image": child.get("image", "")})
        return out

    shows = []
    for c in containers:
        if (c.get("title") or "").lower().startswith("top podcasts"):
            shows = rail_shows(c)
            break
    if len(shows) < 5:
        for c in containers:
            s = rail_shows(c)
            if len(s) >= 8:
                shows = s
                break
    if not shows:
        raise HTTPException(status_code=502, detail="no podcast rails found on tunein.com")
    _tunein_popular_cache["shows"] = shows
    _tunein_popular_cache["at"] = loop.time()
    return {"shows": shows}


def _orion_station_location(name: str, image_url: str, stream_url: str) -> str:
    """Wrap an arbitrary stream URL the way the webui wraps LOCAL_INTERNET_RADIO
    presets: base64 {name,imageUrl,streamUrl} through the orion bmx adapter."""
    payload = _base64.b64encode(
        _json.dumps({"name": name, "imageUrl": image_url, "streamUrl": stream_url}).encode()
    ).decode()
    return f"{settings.base_url}/core02/svc-bmx-adapter-orion/prod/orion/station?data={_urlquote(payload)}"


async def _resolve_tunein_stream(guide_id: str) -> tuple:
    """guide_id (t.../s...) -> (final stream URL, title).

    Pre-follows the redirect chain server-side with a plain GET (headers
    only -- a Range probe gets its params baked into the final CDN URL).
    """
    headers = {"User-Agent": "Mozilla/5.0"}
    try:
        async with _httpx.AsyncClient(timeout=10.0, headers=headers) as client:
            r = await client.get(f"https://opml.radiotime.com/Tune.ashx?id={guide_id}&render=json")
            tune = r.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"TuneIn OPML error: {e}")
    body_items = tune.get("body", [])
    raw_url = body_items[0].get("url", "") if body_items else ""
    if not raw_url:
        raise HTTPException(status_code=404, detail=f"No stream found for {guide_id}")
    title = tune.get("head", {}).get("title", "") or "TuneIn"
    final_url = raw_url
    try:
        async with _httpx.AsyncClient(follow_redirects=True, timeout=15.0, headers=headers) as client:
            async with client.stream("GET", raw_url) as resp:
                final_url = str(resp.url)
    except Exception:
        pass  # fall back to the unresolved URL; the orion proxy may still cope
    return final_url, title


async def _extract_tunein_guide_id(url: str) -> str:
    """Follow a tun.in / tunein.com link and pull the guide id out of the
    final page URL (?topicid=NNN or a /p|s|tNNN path segment)."""
    try:
        async with _httpx.AsyncClient(
            follow_redirects=True, timeout=10.0, headers={"User-Agent": "Mozilla/5.0"}
        ) as client:
            r = await client.get(url)
            final_page = str(r.url)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not resolve URL: {e}")
    m = re.search(r"topicid=(\d+)", final_page, re.IGNORECASE)
    if m:
        return f"t{m.group(1)}"
    m = re.search(r"[/\-]([tps]\d+)(?:[/?]|$)", final_page, re.IGNORECASE)
    if m:
        return m.group(1)
    raise HTTPException(status_code=400, detail=f"Could not extract guide ID from: {final_page}")


@app.post("/api/v1/tunein/resolve-url", tags=["soundcork-api"])
async def api_tunein_resolve_url(request: Request):
    """Resolve a tun.in / tunein.com URL to favorite-ready metadata.

    Returns {guide_id, kind, name, image, show_id, show_title} where kind
    is "show" (p...), "station" (s...) or "episode" (t...).
    """
    body = await request.json()
    url = (body.get("url") or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="url is required")
    guide_id = await _extract_tunein_guide_id(url)
    kind = {"p": "show", "s": "station", "t": "episode"}[guide_id[0]]
    name, image, show_id, show_title = guide_id, "", None, None
    try:
        async with _httpx.AsyncClient(timeout=10.0, headers={"User-Agent": "Mozilla/5.0"}) as client:
            r = await client.get(f"https://opml.radiotime.com/describe.ashx?id={guide_id}&render=json")
            d = (r.json().get("body") or [{}])[0]
        name = d.get("title") or d.get("name") or d.get("text") or guide_id
        image = d.get("logo") or d.get("image") or ""
        show_id = d.get("show_id")
        show_title = d.get("show_title")
    except Exception:
        pass  # favorite still works with the bare guide id as its name
    return {
        "guide_id": guide_id,
        "kind": kind,
        "name": name,
        "image": image,
        "show_id": show_id,
        "show_title": show_title,
    }


@app.get("/card/soundcork-preset-editor.js", include_in_schema=False)
async def api_card_js():
    """Serve the lovelace card straight from soundcork. Point the HA
    dashboard resource at this URL and card updates ship with normal
    server deploys instead of manual copies into HA's www/ folder."""
    path = "/app/soundcork/card/soundcork-preset-editor.js"
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="card not bundled in this image")
    return FileResponse(path, media_type="application/javascript")


@app.post("/api/v1/tunein/play-podcast", tags=["soundcork-api"])
async def api_play_podcast(request: Request):
    """
    Play a TuneIn podcast episode (t...), live station (s...) or show (p...,
    plays its latest episode) on speakers.

    Body JSON:
    {
      "guide_id": "t580783066",          # from /api/v1/tunein/episodes or search
      "url": "http://tun.in/tLU13Y",     # alternative to guide_id
      "title": "...", "image": "...",    # optional display metadata
      "master_ip": "192.168.1.41",
      "master_device_id": "587A6274B5C4",
      "slaves": [{"ip": "...", "device_id": "..."}]
    }

    The master is confirmed playing before slaves are zoned -- zoning an
    unconfirmed master drops the whole group into INVALID_SOURCE (same
    choreography the lovelace card uses for presets).
    """
    body = await request.json()
    guide_id = (body.get("guide_id") or "").strip()
    url = (body.get("url") or "").strip()
    master_ip = body.get("master_ip", "")
    slaves = body.get("slaves", [])

    if not master_ip or not (guide_id or url):
        raise HTTPException(status_code=400, detail="master_ip and guide_id (or url) are required")
    if guide_id and not re.fullmatch(r"[pts]\d+", guide_id):
        raise HTTPException(status_code=400, detail="guide_id must be an episode (t...), station (s...) or show (p...) id")

    if not guide_id:
        guide_id = await _extract_tunein_guide_id(url)

    if guide_id.startswith("p"):
        # Show id: play its most recent episode
        try:
            async with _httpx.AsyncClient(timeout=10.0, headers={"User-Agent": "Mozilla/5.0"}) as client:
                r = await client.get(f"https://opml.radiotime.com/Tune.ashx?c=pbrowse&id={guide_id}&render=json")
                data = r.json()
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"TuneIn episode list failed: {e}")
        latest = next(
            (c for s in data.get("body", []) for c in s.get("children", [])
             if c.get("item") == "topic" and c.get("guide_id")),
            None,
        )
        if latest is None:
            raise HTTPException(status_code=404, detail=f"No episodes found for show {guide_id}")
        guide_id = latest["guide_id"]
        if not (body.get("title") or "").strip():
            body["title"] = latest.get("text", "")
        if not (body.get("image") or "").strip():
            body["image"] = latest.get("image", "")

    stream_url, resolved_title = await _resolve_tunein_stream(guide_id)
    title = (body.get("title") or "").strip() or resolved_title
    image = (body.get("image") or "").strip()

    result = await _play_wrapped_stream(
        stream_url, title, image, master_ip, body.get("master_device_id", ""), slaves
    )
    result["guide_id"] = guide_id
    return result


async def _select_confirm_zone(
    content_item_xml: str,
    master_ip: str,
    master_device_id: str,
    slaves: list,
) -> bool:
    """/select a ContentItem on the master, confirm PLAY_STATE, zone slaves.

    Shared by every tile that plays via ContentItem selection -- the orion
    wrap pipeline (_play_wrapped_stream) and native-source tiles (Spotify).
    Returns whether the master confirmed PLAY/BUFFERING; zoning an
    unconfirmed master drops the whole group into INVALID_SOURCE, so
    unconfirmed masters get independent-playback fallback on each slave.
    """
    try:
        async with _httpx.AsyncClient(timeout=_SPEAKER_TIMEOUT) as client:
            await client.post(
                _speaker_url(master_ip, "/select"),
                content=content_item_xml.encode(),
                headers={"Content-Type": "application/xml"},
            )
    except _httpx.ConnectError:
        raise HTTPException(status_code=503, detail=f"Cannot reach speaker at {master_ip}")
    except _httpx.TimeoutException:
        raise HTTPException(status_code=504, detail=f"Speaker at {master_ip} timed out")

    confirmed = False
    for _ in range(10):
        await asyncio.sleep(1.0)
        try:
            async with _httpx.AsyncClient(timeout=_SPEAKER_TIMEOUT) as client:
                np = await client.get(_speaker_url(master_ip, "/nowPlaying"))
            if "PLAY_STATE" in np.text or "BUFFERING_STATE" in np.text:
                confirmed = True
                break
        except Exception:
            pass

    if slaves and confirmed:
        members = "".join(f'<member ipaddress="{s["ip"]}">{s["device_id"]}</member>' for s in slaves)
        zone_xml = (
            f'<zone master="{master_device_id}" '
            f'senderIPAddress="{master_ip}">{members}</zone>'
        )
        try:
            async with _httpx.AsyncClient(timeout=_SPEAKER_TIMEOUT) as client:
                await client.post(
                    _speaker_url(master_ip, "/setZone"),
                    content=zone_xml.encode(),
                    headers={"Content-Type": "application/xml"},
                )
        except Exception:
            pass
    elif slaves:
        # Master never confirmed; play independently so audio still happens
        for s in slaves:
            try:
                async with _httpx.AsyncClient(timeout=_SPEAKER_TIMEOUT) as client:
                    await client.post(
                        _speaker_url(s["ip"], "/select"),
                        content=content_item_xml.encode(),
                        headers={"Content-Type": "application/xml"},
                    )
            except Exception:
                pass

    return confirmed


async def _play_wrapped_stream(
    stream_url: str,
    title: str,
    image: str,
    master_ip: str,
    master_device_id: str,
    slaves: list,
    resolve_redirects: bool = False,
) -> dict:
    """Shared playback pipeline for any provider that yields a direct audio
    URL (TuneIn, Pushkin, iHeart...): optional redirect pre-resolution, orion
    wrap, select on master, confirm PLAY_STATE before zoning slaves."""
    if resolve_redirects:
        try:
            async with _httpx.AsyncClient(
                follow_redirects=True, timeout=15.0, headers={"User-Agent": "Mozilla/5.0"}
            ) as client:
                async with client.stream("GET", stream_url) as resp:
                    stream_url = str(resp.url)
        except Exception:
            pass  # fall back to the unresolved URL; the orion proxy may still cope

    location = _orion_station_location(title, image, stream_url)
    xml = (
        f'<ContentItem source="LOCAL_INTERNET_RADIO" type="stationurl" '
        f'location={_xml_quoteattr(location)} isPresetable="false">'
        f"<itemName>{_xml_escape(title)}</itemName>"
        f"<containerArt>{_xml_escape(image)}</containerArt>"
        f"</ContentItem>"
    )

    confirmed = await _select_confirm_zone(xml, master_ip, master_device_id, slaves)

    return {
        "success": True,
        "title": title,
        "speakers": len(slaves) + 1,
        "play_confirmed": confirmed,
        "stream_url": stream_url,
    }


@app.post("/api/v1/play-stream", tags=["soundcork-api"])
async def api_play_stream(request: Request):
    """Play any direct audio URL on speakers via the shared orion pipeline.

    Used by provider tiles (Pushkin, iHeart, ...) whose resolvers already
    produced an MP3/stream URL. Redirect chains are pre-followed here.
    Body: {stream_url, title?, image?, master_ip, master_device_id, slaves}
    """
    body = await request.json()
    stream_url = (body.get("stream_url") or "").strip()
    master_ip = body.get("master_ip", "")
    if not stream_url.startswith(("http://", "https://")) or not master_ip:
        raise HTTPException(status_code=400, detail="stream_url (http/https) and master_ip are required")
    return await _play_wrapped_stream(
        stream_url,
        (body.get("title") or "").strip() or "Podcast",
        (body.get("image") or "").strip(),
        master_ip,
        body.get("master_device_id", ""),
        body.get("slaves", []),
        resolve_redirects=True,
    )


# ---------------------------------------------------------------------------
# Pushkin Industries (pushkin.fm)
# Fixed curated catalog (~30 shows) scraped from pushkin.fm/podcasts; each
# show page links its Omny RSS feed, whose enclosures are the same
# podtrac/pscrb redirect-chain MP3s TuneIn episodes use -- playback goes
# through the shared _play_wrapped_stream pipeline via /api/v1/play-stream.
# ---------------------------------------------------------------------------

_PUSHKIN_TTL_SECONDS = 6 * 3600.0
_pushkin_cache = {"shows": None, "at": 0.0, "rss": {}}


def _parse_itunes_duration(val) -> int | None:
    val = str(val or "").strip()
    if not val:
        return None
    try:
        parts = [int(p) for p in val.split(":")]
    except ValueError:
        return None
    secs = 0
    for p in parts:
        secs = secs * 60 + p
    return secs


@app.get("/api/v1/pushkin/shows", tags=["soundcork-api"])
async def api_pushkin_shows():
    """Pushkin Industries show catalog, scraped from pushkin.fm (cached 6h)."""
    loop = asyncio.get_event_loop()
    if _pushkin_cache["shows"] and loop.time() - _pushkin_cache["at"] < _PUSHKIN_TTL_SECONDS:
        return {"shows": _pushkin_cache["shows"]}
    try:
        async with _httpx.AsyncClient(timeout=15.0, headers={"User-Agent": "Mozilla/5.0"}) as client:
            r = await client.get("https://www.pushkin.fm/podcasts")
            html = r.text
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"pushkin.fm catalog fetch failed: {e}")
    shows = {}
    for m in re.finditer(
        r'<a[^>]*href="https://www\.pushkin\.fm/podcasts/([a-z0-9-]+)"[^>]*>(.*?)</a>', html, re.S
    ):
        slug = m.group(1)
        name = re.sub(r"<[^>]+>", " ", m.group(2))
        name = re.sub(r"\s+", " ", name).strip()
        if name and slug not in shows:
            shows[slug] = {"slug": slug, "name": name}
    # Keep pushkin.fm's own page order -- it's editorial (flagship shows
    # first), which is the closest thing Pushkin has to a popularity rank.
    result = list(shows.values())
    if result:
        _pushkin_cache["shows"] = result
        _pushkin_cache["at"] = loop.time()
    return {"shows": result}


@app.get("/api/v1/pushkin/episodes", tags=["soundcork-api"])
async def api_pushkin_episodes(show: str):
    """Recent episodes for a Pushkin show (slug from /api/v1/pushkin/shows).

    Discovers the show's Omny RSS feed from its pushkin.fm page, then parses
    the feed: enclosure MP3 URL, title, pubDate, itunes duration, artwork.
    """
    if not re.fullmatch(r"[a-z0-9-]{1,80}", show):
        raise HTTPException(status_code=400, detail="show must be a pushkin.fm slug")
    headers = {"User-Agent": "Mozilla/5.0"}
    rss_url = _pushkin_cache["rss"].get(show)
    if not rss_url:
        try:
            async with _httpx.AsyncClient(timeout=15.0, headers=headers) as client:
                r = await client.get(f"https://www.pushkin.fm/podcasts/{show}")
                page = r.text
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"pushkin.fm show page fetch failed: {e}")
        m = re.search(r'https?://[^"\'\s]*omny\.fm/[^"\'\s]*podcast\.rss', page) or re.search(
            r'[^"\'\s]*omny\.fm/shows/[^"\'\s]*podcast\.rss', page
        )
        if not m:
            raise HTTPException(status_code=404, detail=f"No RSS feed found for show {show}")
        rss_url = m.group(0)
        if not rss_url.startswith("http"):
            rss_url = "https://" + rss_url.lstrip("/")
        _pushkin_cache["rss"][show] = rss_url
    try:
        async with _httpx.AsyncClient(follow_redirects=True, timeout=20.0, headers=headers) as client:
            r = await client.get(rss_url)
            root = ET.fromstring(r.content)
    except Exception as e:
        _pushkin_cache["rss"].pop(show, None)
        raise HTTPException(status_code=502, detail=f"RSS fetch/parse failed: {e}")
    itunes_ns = {"itunes": "http://www.itunes.com/dtds/podcast-1.0.dtd"}
    channel = root.find("channel")
    if channel is None:
        raise HTTPException(status_code=502, detail="RSS feed had no channel element")
    show_image_el = channel.find("itunes:image", itunes_ns)
    show_image = show_image_el.get("href", "") if show_image_el is not None else ""
    episodes = []
    for item in channel.findall("item")[:50]:
        enclosure = item.find("enclosure")
        if enclosure is None or not enclosure.get("url"):
            continue
        item_image_el = item.find("itunes:image", itunes_ns)
        episodes.append(
            {
                "title": item.findtext("title", default=""),
                "date": item.findtext("pubDate", default=""),
                "duration_seconds": _parse_itunes_duration(
                    item.findtext("itunes:duration", default="", namespaces=itunes_ns)
                ),
                "audio_url": enclosure.get("url"),
                "image": item_image_el.get("href", "") if item_image_el is not None else show_image,
            }
        )
    return {
        "show": {
            "slug": show,
            "name": channel.findtext("title", default=show),
            "image": show_image,
            "rss": rss_url,
        },
        "episodes": episodes,
    }


# ---------------------------------------------------------------------------
# iHeart (us.api.iheart.com)
# Public, unauthenticated API v3; wants a browser User-Agent. Verified
# 2026-10-03:
#   /search/all?...&podcast=true          -> results.podcasts[{id, title,
#       description, image}] (search calls the artwork "image"; the show
#       endpoint calls it "imageUrl")
#   /podcast/podcasts/{id}                -> {id, title, description, imageUrl}
#   /podcast/podcasts/{id}/episodes?limit -> {data: [{id, title, duration
#       (already seconds), startDate (epoch MILLISECONDS), imageUrl}]}
#       -- the list has NO mediaUrl; it must be resolved per episode
#   /podcast/episodes/{episodeId}         -> {"episode": {..., mediaUrl}}
#       (payload nests under "episode"; unknown ids return 404
#       {"error": "..."}).
# mediaUrl is a podtrac/pscrb/Omny redirect-chain MP3 -- the same technology
# TuneIn/Pushkin episodes use -- played through the shared
# _play_wrapped_stream pipeline via /api/v1/play-stream, which pre-follows
# the redirects for the SoundTouch firmware.
# ---------------------------------------------------------------------------

from datetime import timezone as _dt_timezone

_IHEART_API = "https://us.api.iheart.com/api/v3"
_IHEART_ID_RE = r"\d{1,20}"
_IHEART_TTL_SECONDS = 6 * 3600.0
_iheart_cache = {"shows": {}}  # show id -> {"show": {...}, "at": loop.time()}


def _iheart_date(epoch_ms) -> str:
    """iHeart startDate (epoch milliseconds) -> 'Oct 1, 2026' ('' if absent)."""
    try:
        dt = datetime.fromtimestamp(int(epoch_ms) / 1000.0, tz=_dt_timezone.utc)
    except (TypeError, ValueError, OSError, OverflowError):
        return ""
    return f"{dt.strftime('%b')} {dt.day}, {dt.year}"


def _iheart_error_detail(resp, fallback: str) -> str:
    """Pull iHeart's {"error": "..."} message out of an error response."""
    try:
        return resp.json().get("error") or fallback
    except Exception:
        return fallback


@app.get("/api/v1/iheart/search", tags=["soundcork-api"])
async def api_iheart_search(q: str):
    """Search iHeart podcasts -> {"shows": [{guide_id, name, description, image}]}.

    guide_id is iHeart's numeric show id, returned as a string so the card
    and the iheart favorites provider treat it uniformly.
    """
    q = (q or "").strip()
    if not q:
        raise HTTPException(status_code=400, detail="q is required")
    try:
        async with _httpx.AsyncClient(timeout=10.0, headers={"User-Agent": "Mozilla/5.0"}) as client:
            r = await client.get(
                f"{_IHEART_API}/search/all",
                params={
                    "keywords": q,
                    "maxRows": 20,
                    "podcast": "true",
                    "station": "false",
                    "artist": "false",
                    "track": "false",
                    "bundle": "false",
                },
            )
            r.raise_for_status()
            data = r.json()
    except _httpx.HTTPStatusError as e:
        raise HTTPException(status_code=502, detail=f"iHeart search failed: HTTP {e.response.status_code}")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"iHeart search failed: {e}")
    shows = []
    for p in (data.get("results") or {}).get("podcasts") or []:
        if p.get("id") is None or not p.get("title"):
            continue
        shows.append(
            {
                "guide_id": str(p["id"]),
                "name": p["title"],
                "description": p.get("description") or p.get("subtitle") or "",
                "image": p.get("image") or "",
            }
        )
    return {"shows": shows}


@app.get("/api/v1/iheart/episodes", tags=["soundcork-api"])
async def api_iheart_episodes(id: str):
    """Recent episodes for an iHeart show (numeric id, 50 most recent).

    Returns {"show": {guide_id, name, image}, "episodes": [{episode_id,
    title, date, duration_seconds, image}]}. The episode list carries no
    mediaUrl -- playback resolves it per episode via
    /api/v1/iheart/episode-stream. Show metadata is cached 6h.
    """
    if not re.fullmatch(_IHEART_ID_RE, id):
        raise HTTPException(status_code=400, detail="id must be a numeric iHeart show id like 29236323")
    loop = asyncio.get_event_loop()
    cached = _iheart_cache["shows"].get(id)
    show = cached["show"] if cached and loop.time() - cached["at"] < _IHEART_TTL_SECONDS else None
    try:
        async with _httpx.AsyncClient(timeout=15.0, headers={"User-Agent": "Mozilla/5.0"}) as client:
            if show is None:
                sr, er = await asyncio.gather(
                    client.get(f"{_IHEART_API}/podcast/podcasts/{id}"),
                    client.get(f"{_IHEART_API}/podcast/podcasts/{id}/episodes", params={"limit": 50}),
                )
            else:
                sr = None
                er = await client.get(f"{_IHEART_API}/podcast/podcasts/{id}/episodes", params={"limit": 50})
            if er.status_code == 404 or (sr is not None and sr.status_code == 404):
                bad = er if er.status_code == 404 else sr
                raise HTTPException(
                    status_code=404, detail=_iheart_error_detail(bad, f"iHeart show {id} not found")
                )
            er.raise_for_status()
            ep_data = er.json()
            if show is None:
                sr.raise_for_status()
                sd = sr.json()
                show = {"guide_id": id, "name": sd.get("title") or id, "image": sd.get("imageUrl") or ""}
                _iheart_cache["shows"][id] = {"show": show, "at": loop.time()}
    except HTTPException:
        raise
    except _httpx.HTTPStatusError as e:
        raise HTTPException(status_code=502, detail=f"iHeart episode list failed: HTTP {e.response.status_code}")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"iHeart episode list failed: {e}")
    episodes = []
    for ep in (ep_data.get("data") or [])[:50]:
        if ep.get("id") is None:
            continue
        episodes.append(
            {
                "episode_id": str(ep["id"]),
                "title": ep.get("title") or "",
                "date": _iheart_date(ep.get("startDate")),
                "duration_seconds": ep.get("duration"),
                "image": ep.get("imageUrl") or show["image"],
            }
        )
    return {"show": show, "episodes": episodes}


@app.get("/api/v1/iheart/episode-stream", tags=["soundcork-api"])
async def api_iheart_episode_stream(id: str):
    """Resolve an iHeart episode id -> {"stream_url", "title", "image"}.

    stream_url is the episode detail's mediaUrl (podtrac/pscrb/Omny redirect
    chain) -- feed it to /api/v1/play-stream, which pre-follows the chain.
    404 if iHeart doesn't know the episode or it carries no mediaUrl.
    """
    if not re.fullmatch(_IHEART_ID_RE, id):
        raise HTTPException(status_code=400, detail="id must be a numeric iHeart episode id")
    try:
        async with _httpx.AsyncClient(timeout=10.0, headers={"User-Agent": "Mozilla/5.0"}) as client:
            r = await client.get(f"{_IHEART_API}/podcast/episodes/{id}")
            if r.status_code == 404:
                raise HTTPException(
                    status_code=404, detail=_iheart_error_detail(r, f"iHeart episode {id} not found")
                )
            r.raise_for_status()
            data = r.json()
    except HTTPException:
        raise
    except _httpx.HTTPStatusError as e:
        raise HTTPException(status_code=502, detail=f"iHeart episode lookup failed: HTTP {e.response.status_code}")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"iHeart episode lookup failed: {e}")
    ep = data.get("episode") or {}
    media_url = (ep.get("mediaUrl") or "").strip()
    if not media_url:
        raise HTTPException(status_code=404, detail=f"iHeart episode {id} has no mediaUrl (not playable)")
    return {"stream_url": media_url, "title": ep.get("title") or "", "image": ep.get("imageUrl") or ""}


# ---------------------------------------------------------------------------
# Spotify (native speaker source -- NOT the orion proxy pipeline)
#
# SoundTouch firmware embeds Spotify's eSDK: the speaker's own client pulls
# the DRM'd audio, so unlike TuneIn/Pushkin/iHeart we never see a stream URL.
# This tile drives the speaker's SPOTIFY source via ContentItem /select.
#
# ContentItem format (researched 2026-10-02):
#   - Upstream soundcork (timvw/soundcork) webui stores working Spotify
#     presets as: <ContentItem source="SPOTIFY" type="tracklisturl"
#     location="/playback/container/{base64(spotify:URI)}"
#     sourceAccount="{spotifyUserId}" isPresetable="true"> (app.js ~1305).
#     Upstream examples/Recents.xml confirms the same shape for recents.
#   - Our speakers' Sources.xml currently has NO SPOTIFY source (checked
#     2026-10-02 on 192.168.1.229:/soundcork/data/4365315/Sources.xml), so
#     sourceAccount cannot be discovered yet; /play returns 409 until a
#     Spotify account is linked on the speakers (upstream linking flow:
#     SPOTIFY_CLIENT_ID/SECRET + /mgmt/spotify OAuth + ZeroConf primer).
#
# Search/episodes use the Spotify Web API client-credentials flow, which
# suffices for catalog lookups (no user scope). 2026 Spotify API facts:
#   - show/episode search and /shows/{id}/episodes REQUIRE an explicit
#     market param under client-credentials (no user country to infer);
#     omitting it yields null/empty results.
#   - tokens last 3600s; cached here until 60s before expiry.
# ---------------------------------------------------------------------------

_SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token"
_SPOTIFY_API = "https://api.spotify.com/v1"
_SPOTIFY_MARKET = "US"

# Spotify's authorize endpoint rejects plain-HTTP redirect URIs on LAN
# addresses at runtime ("redirect_uri: Insecure", observed 2026-10-03)
# even though the developer dashboard accepts registering them. HTTP IS
# still allowed for loopback, so account linking goes through a
# 127.0.0.1 redirect URI (registered in the app alongside the LAN one):
# the browser lands on a dead 127.0.0.1 page whose URL carries ?code=,
# and /link/complete exchanges that code server-side with the matching
# redirect_uri (both OAuth legs must use the same one).
_SPOTIFY_LOOPBACK_REDIRECT = "http://127.0.0.1:8000/mgmt/spotify/callback"


@app.get("/api/v1/spotify/link", include_in_schema=False)
async def api_spotify_link():
    """Start OAuth account linking. Open in a browser logged into the
    (Premium) Spotify account; survives Spotify's HTTPS-or-loopback rule."""
    from soundcork.mgmt import spotify as _spotify_svc

    if not settings.spotify_client_id:
        raise HTTPException(status_code=503, detail="SPOTIFY_CLIENT_ID not configured")
    return RedirectResponse(url=_spotify_svc.build_authorize_url(redirect_uri=_SPOTIFY_LOOPBACK_REDIRECT))


_SPOTIFY_LINK_PAGE = """<!doctype html><html><head><title>Link Spotify - SoundCork</title>
<style>body{font-family:sans-serif;background:#1a1a2e;color:#eee;max-width:640px;margin:40px auto;padding:0 16px;line-height:1.6}
a,button{color:#1db954}input{width:100%;padding:10px;border-radius:8px;border:1px solid #444;background:#222;color:#eee;font-family:monospace}
button{background:#1db954;color:#000;border:none;border-radius:8px;padding:10px 22px;font-weight:700;cursor:pointer;margin-top:10px}
.step{background:#23233a;border-radius:10px;padding:14px 18px;margin:12px 0}</style></head><body>
<h2>Link a Spotify account</h2>
<p>Spotify only allows this flow through a <code>127.0.0.1</code> address, so the last page will look broken - that's expected.</p>
<div class="step"><b>Step 1.</b> Make sure this browser is logged in to the <b>Spotify Premium</b> account you want on the speakers, then
<a href="/api/v1/spotify/link" target="_blank">click here to approve access</a>.</div>
<div class="step"><b>Step 2.</b> After clicking <b>Agree</b>, you'll land on a dead page at <code>127.0.0.1</code>. Copy its <b>full address</b> from the address bar.</div>
<div class="step"><b>Step 3.</b> Paste it here and finish:
<form method="get" action="/api/v1/spotify/link/complete">
<input name="url" placeholder="http://127.0.0.1:8000/mgmt/spotify/callback?code=..." autocomplete="off"/>
<button type="submit">Link account</button></form></div>
</body></html>"""


@app.get("/api/v1/spotify/link/complete", tags=["soundcork-api"])
async def api_spotify_link_complete(code: str = "", url: str = ""):
    """Guided finish for Spotify account linking.

    With no params: serves the step-by-step page the webui's "+" button
    opens. With ?url= (the dead 127.0.0.1 address the browser lands on
    after approving) or ?code=: exchanges the authorization code using
    the loopback redirect_uri and stores the account.
    """
    from soundcork.mgmt import spotify as _spotify_svc

    if not code and url:
        m = re.search(r"[?&]code=([^&\s]+)", url)
        if not m:
            return HTMLResponse(
                "<html><body><h2>No code found in that address</h2>"
                "<p>It should contain <code>?code=...</code> - go back and copy the full address.</p></body></html>",
                status_code=400,
            )
        code = m.group(1)
    if not code:
        return HTMLResponse(_SPOTIFY_LINK_PAGE)
    try:
        account = await _spotify_svc.exchange_code_and_store(code, redirect_uri=_SPOTIFY_LOOPBACK_REDIRECT)
    except Exception as e:
        return HTMLResponse(
            f"<html><body><h2>Linking failed</h2><p>{_xml_escape(str(e))}</p>"
            "<p>Authorization codes expire after a few minutes - "
            '<a href="/api/v1/spotify/link/complete">start over</a>.</p></body></html>',
            status_code=502,
        )
    return HTMLResponse(
        f"<html><body><h2>Spotify Connected</h2>"
        f"<p>Linked: {_xml_escape(str(account.get('displayName', '')))} ({_xml_escape(str(account.get('spotifyUserId', '')))})</p>"
        "<p>The speakers will be provisioned on the next server restart "
        "(or automatically within 45 minutes). You can close this tab.</p></body></html>"
    )
_SPOTIFY_URI_RE = r"spotify:(track|album|playlist|artist|show|episode):[A-Za-z0-9]{22}"

_spotify_cc_token = {"token": None, "expires_at": 0.0}
_SPOTIFY_ACCOUNT_TTL_SECONDS = 600.0
_spotify_account_cache = {"account": None, "at": 0.0}


def _spotify_configured() -> bool:
    """Web-API creds present? Read from upstream Settings (env vars
    SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET -- same vars the upstream
    OAuth/ZeroConf-primer stack uses, so one pair of creds powers both)."""
    return bool(settings.spotify_client_id and settings.spotify_client_secret)


def _spotify_speaker_account() -> str | None:
    """sourceAccount for SPOTIFY ContentItems, from the speakers' synced
    Sources.xml (<sourceKey type="SPOTIFY" account="..."/>). Scans
    data_dir/*/Sources.xml (per-account dirs like 4365315/) plus the data
    root; unparseable files (the root copy is a UTF-16 PowerShell dump)
    are skipped. Cached 10 min. None => no Spotify account linked."""
    loop = asyncio.get_event_loop()
    if _spotify_account_cache["at"] and loop.time() - _spotify_account_cache["at"] < _SPOTIFY_ACCOUNT_TTL_SECONDS:
        return _spotify_account_cache["account"]
    account = None
    candidates = [os.path.join(settings.data_dir, "Sources.xml")]
    try:
        for entry in sorted(os.listdir(settings.data_dir)):
            candidates.append(os.path.join(settings.data_dir, entry, "Sources.xml"))
    except OSError:
        pass
    for path in candidates:
        try:
            root = ET.parse(path).getroot()
        except (OSError, ET.ParseError):
            continue
        for key in root.iter("sourceKey"):
            if key.get("type") == "SPOTIFY" and key.get("account"):
                account = key.get("account")
                break
        if account:
            break
    _spotify_account_cache["account"] = account
    _spotify_account_cache["at"] = loop.time()
    return account


async def _spotify_web_token() -> str:
    """Client-credentials access token, cached until 60s before expiry."""
    if not _spotify_configured():
        raise HTTPException(
            status_code=503,
            detail="Spotify Web API not configured -- set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET",
        )
    loop = asyncio.get_event_loop()
    if _spotify_cc_token["token"] and loop.time() < _spotify_cc_token["expires_at"]:
        return _spotify_cc_token["token"]
    try:
        async with _httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(
                _SPOTIFY_TOKEN_URL,
                data={"grant_type": "client_credentials"},
                auth=(settings.spotify_client_id, settings.spotify_client_secret),
            )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Spotify token request failed: {e}")
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Spotify token request rejected: {r.text[:200]}")
    data = r.json()
    _spotify_cc_token["token"] = data["access_token"]
    _spotify_cc_token["expires_at"] = loop.time() + data.get("expires_in", 3600) - 60
    return _spotify_cc_token["token"]


def _spotify_image(images: list) -> str:
    """Mid-size image URL from a Spotify images array (sorted largest
    first); the 300px variant when present, else whatever exists."""
    if not images:
        return ""
    pick = images[1] if len(images) > 1 else images[0]
    return pick.get("url", "")


@app.get("/api/v1/spotify/status", tags=["soundcork-api"])
async def api_spotify_status():
    """Card bootstrap: is search usable, and can the speakers play natively?

    configured      -- SPOTIFY_CLIENT_ID/SECRET env vars present (Web API
                       search works).
    speaker_account -- SPOTIFY sourceAccount found in Sources.xml, else
                       null (= no Spotify account linked on the speakers;
                       /play will refuse with 409 until one is linked).
    """
    return {"configured": _spotify_configured(), "speaker_account": _spotify_speaker_account()}


@app.get("/api/v1/spotify/search", tags=["soundcork-api"])
async def api_spotify_search(q: str, type: str = "show"):
    """Catalog search for podcast shows by name. Returns
    {shows: [{uri, name, publisher, image}]}."""
    if type != "show":
        raise HTTPException(status_code=400, detail="only type=show is supported")
    if not q.strip():
        raise HTTPException(status_code=400, detail="q is required")
    token = await _spotify_web_token()
    try:
        async with _httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(
                f"{_SPOTIFY_API}/search",
                params={"q": q.strip(), "type": "show", "limit": 20, "market": _SPOTIFY_MARKET},
                headers={"Authorization": f"Bearer {token}"},
            )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Spotify search failed: {e}")
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Spotify search error: {r.text[:200]}")
    shows = []
    for item in (r.json().get("shows") or {}).get("items") or []:
        if not item:
            continue
        shows.append(
            {
                "uri": item.get("uri", ""),
                "name": item.get("name", ""),
                "publisher": item.get("publisher", ""),
                "image": _spotify_image(item.get("images") or []),
            }
        )
    return {"shows": shows}


@app.get("/api/v1/spotify/episodes", tags=["soundcork-api"])
async def api_spotify_episodes(id: str):
    """50 newest episodes of a show (id = base62 show id or spotify:show:
    URI). Returns {episodes: [{uri, title, date, duration_seconds, image}]}."""
    show_id = id.split(":")[-1].strip()
    if not re.fullmatch(r"[A-Za-z0-9]{22}", show_id):
        raise HTTPException(status_code=400, detail="id must be a 22-char Spotify show id or spotify:show: URI")
    token = await _spotify_web_token()
    try:
        async with _httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(
                f"{_SPOTIFY_API}/shows/{show_id}/episodes",
                params={"limit": 50, "market": _SPOTIFY_MARKET},
                headers={"Authorization": f"Bearer {token}"},
            )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Spotify episodes failed: {e}")
    if r.status_code == 404:
        raise HTTPException(status_code=404, detail=f"Spotify show {show_id} not found")
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Spotify episodes error: {r.text[:200]}")
    episodes = []
    for item in r.json().get("items") or []:
        if not item:
            continue  # API pads removed episodes with nulls
        duration_ms = item.get("duration_ms")
        episodes.append(
            {
                "uri": item.get("uri", ""),
                "title": item.get("name", ""),
                "date": item.get("release_date", ""),
                "duration_seconds": round(duration_ms / 1000) if duration_ms else None,
                "image": _spotify_image(item.get("images") or []),
            }
        )
    return {"show_id": show_id, "episodes": episodes}


@app.post("/api/v1/spotify/play", tags=["soundcork-api"])
async def api_spotify_play(request: Request):
    """Play a Spotify URI on speakers via the NATIVE SPOTIFY source.

    Body: {uri, title?, image?, source_account?, master_ip,
           master_device_id, slaves: [{ip, device_id}]}

    Builds the ContentItem shape upstream's webui stores as working
    presets (see section header for evidence):
      source="SPOTIFY" type="tracklisturl"
      location="/playback/container/{base64(uri)}"
      sourceAccount={Spotify user id from Sources.xml}
    then runs the shared select -> confirm PLAY_STATE -> zone pipeline.

    409s when no Spotify account is linked on the speakers (the firmware
    rejects /select for sources it has no credentials for); the optional
    source_account body field overrides discovery for hardware testing.
    """
    body = await request.json()
    uri = (body.get("uri") or "").strip()
    master_ip = body.get("master_ip", "")
    slaves = body.get("slaves", [])
    if not master_ip or not uri:
        raise HTTPException(status_code=400, detail="master_ip and uri are required")
    if not re.fullmatch(_SPOTIFY_URI_RE, uri):
        raise HTTPException(
            status_code=400,
            detail="uri must look like spotify:show:... / spotify:episode:... (track, album, playlist, artist also accepted)",
        )
    account = (body.get("source_account") or "").strip() or _spotify_speaker_account()
    if not account:
        raise HTTPException(
            status_code=409,
            detail=(
                "No Spotify account is linked on the speakers (no SPOTIFY source in "
                "Sources.xml). Link a Spotify Premium account via the SoundCork webui "
                "(requires SPOTIFY_CLIENT_ID/SECRET) before native playback can work."
            ),
        )

    title = (body.get("title") or "").strip() or uri
    image = (body.get("image") or "").strip()
    location = "/playback/container/" + _base64.b64encode(uri.encode()).decode()
    xml = (
        f'<ContentItem source="SPOTIFY" type="tracklisturl" '
        f"location={_xml_quoteattr(location)} "
        f"sourceAccount={_xml_quoteattr(account)} "
        f'isPresetable="true">'
        f"<itemName>{_xml_escape(title)}</itemName>"
        f"<containerArt>{_xml_escape(image)}</containerArt>"
        f"</ContentItem>"
    )

    confirmed = await _select_confirm_zone(xml, master_ip, body.get("master_device_id", ""), slaves)

    return {
        "success": True,
        "title": title,
        "speakers": len(slaves) + 1,
        "play_confirmed": confirmed,
        "uri": uri,
    }


# ---------------------------------------------------------------------------
# Server-side group playback orchestration
# The browser makes ONE fire-and-forget call; the server runs the full
# sequence (clear zones -> play master -> confirm PLAY_STATE -> zone slaves)
# so playback is immune to the browser tab closing or the phone locking.
# ---------------------------------------------------------------------------

_PREFERRED_MASTER_IP = "192.168.1.214"  # Kitchen - always-on interior speaker


async def _probe_reachable(client: "_httpx.AsyncClient", ip: str) -> bool:
    try:
        r = await client.get(_speaker_url(ip, "/nowPlaying"), timeout=2.0)
        return r.status_code == 200
    except Exception:
        return False


async def _wait_for_play_state(client: "_httpx.AsyncClient", ip: str, polls: int = 20) -> bool:
    for _ in range(polls):
        await asyncio.sleep(0.5)
        try:
            r = await client.get(_speaker_url(ip, "/nowPlaying"), timeout=2.0)
            if b"PLAY_STATE" in r.content:
                return True
        except Exception:
            pass
    return False


async def _clear_zone_quiet(client: "_httpx.AsyncClient", ip: str) -> None:
    try:
        r = await client.get(_speaker_url(ip, "/info"), timeout=3.0)
        m = None
        text = r.content.decode("utf-8", errors="ignore")
        idx = text.find('deviceID="')
        if idx >= 0:
            m = text[idx + 10 : text.find('"', idx + 10)]
        if m:
            xml = f'<zone master="{m}" senderIPAddress="{ip}"></zone>'
            await client.post(
                _speaker_url(ip, "/setZone"),
                content=xml.encode(),
                headers={"Content-Type": "application/xml"},
            )
    except Exception:
        pass


async def _group_play_task(speakers: list, master_action, slave_action) -> None:
    """
    Full orchestration, runs server-side to completion.
    master_action(client, ip): starts playback on the master.
    slave_action(client, ip): independent-playback fallback for a slave.
    """
    import asyncio as _asyncio
    try:
        async with _httpx.AsyncClient(timeout=_SPEAKER_TIMEOUT) as client:
            # 1. Filter to reachable speakers
            flags = await _asyncio.gather(*[_probe_reachable(client, s["ip"]) for s in speakers])
            reachable = [s for s, ok in zip(speakers, flags) if ok]
            if not reachable:
                logger.warning("group-play: no reachable speakers")
                return

            # 2. Clear stale zones everywhere (kills zombie masters)
            for s in reachable:
                await _clear_zone_quiet(client, s["ip"])
            await _asyncio.sleep(0.5)

            # 3. Pick master: Kitchen if selected, else first reachable
            master = next((s for s in reachable if s["ip"] == _PREFERRED_MASTER_IP), reachable[0])
            slaves = [s for s in reachable if s["ip"] != master["ip"]]

            # 4. Start playback on master, confirm PLAY_STATE (retry once)
            await master_action(client, master["ip"])
            playing = await _wait_for_play_state(client, master["ip"])
            if not playing:
                await master_action(client, master["ip"])
                playing = await _wait_for_play_state(client, master["ip"])

            if not slaves:
                return

            if playing:
                # 5. Zone the confirmed-playing master
                members = "".join(
                    f'<member ipaddress="{s["ip"]}">{s["device_id"]}</member>' for s in slaves
                )
                zone_xml = (
                    f'<zone master="{master["device_id"]}" senderIPAddress="{master["ip"]}">'
                    f"{members}</zone>"
                )
                await client.post(
                    _speaker_url(master["ip"], "/setZone"),
                    content=zone_xml.encode(),
                    headers={"Content-Type": "application/xml"},
                )
                logger.info("group-play: zoned %d slaves to master %s", len(slaves), master["ip"])
            else:
                # 6. Fallback: independent playback everywhere
                logger.warning("group-play: master %s never reached PLAY_STATE, independent fallback", master["ip"])
                await _asyncio.gather(*[slave_action(client, s["ip"]) for s in slaves])
    except Exception as e:
        logger.error("group-play task failed: %s", e)


@app.post("/api/v1/preset/play", tags=["soundcork-api"])
async def api_group_play_preset(request: Request):
    """
    Fire-and-forget group preset playback.
    Body: {"preset_id": 2, "speakers": [{"ip": "...", "device_id": "..."}, ...]}
    Returns immediately; orchestration continues server-side.
    """
    body = await request.json()
    preset_id = int(body.get("preset_id", 0))
    speakers = body.get("speakers", [])
    if not (1 <= preset_id <= 6) or not speakers:
        raise HTTPException(status_code=400, detail="preset_id (1-6) and speakers are required")

    key = f"PRESET_{preset_id}"

    async def press(client, ip):
        await _key_press(client, ip, key)

    asyncio.ensure_future(_group_play_task(speakers, press, press))
    return {"accepted": True, "preset_id": preset_id, "speakers": len(speakers)}


@app.post("/api/v1/select/play", tags=["soundcork-api"])
async def api_group_play_select(request: Request):
    """
    Fire-and-forget group ContentItem playback (Pandora, radio, etc.).
    Body: {"content_item": "<ContentItem .../>", "speakers": [{"ip","device_id"}, ...]}
    """
    body = await request.json()
    content_item = body.get("content_item", "")
    speakers = body.get("speakers", [])
    if not content_item or not speakers:
        raise HTTPException(status_code=400, detail="content_item and speakers are required")

    async def select(client, ip):
        await client.post(
            _speaker_url(ip, "/select"),
            content=content_item.encode(),
            headers={"Content-Type": "application/xml"},
        )

    asyncio.ensure_future(_group_play_task(speakers, select, select))
    return {"accepted": True, "speakers": len(speakers)}
