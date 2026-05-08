"""DataUpdateCoordinator for SoundCork."""
from __future__ import annotations

import logging
import xml.etree.ElementTree as ET
from datetime import timedelta
from typing import Any

import aiohttp
from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import DOMAIN, SCAN_INTERVAL_SECONDS

LOGGER = logging.getLogger(__name__)


def _parse_now_playing(xml_text: str) -> dict[str, Any]:
    """Parse nowPlaying XML into a dict."""
    try:
        root = ET.fromstring(xml_text)
        source = root.attrib.get("source", "STANDBY")
        play_status = root.findtext("playStatus") or ""
        track = root.findtext("track") or ""
        artist = root.findtext("artist") or ""
        album = root.findtext("album") or ""
        station_name = root.findtext("stationName") or ""

        # Get artwork - prefer the <art> element, fall back to containerArt
        art_elem = root.find("art")
        art_url = ""
        if art_elem is not None and art_elem.text:
            art_url = art_elem.text
        else:
            content_item = root.find("ContentItem")
            if content_item is not None:
                art_url = content_item.findtext("containerArt") or ""

        # Get content item details
        content_item = root.find("ContentItem")
        location = ""
        item_name = ""
        if content_item is not None:
            location = content_item.attrib.get("location", "")
            item_name = content_item.findtext("itemName") or ""

        # Determine display title
        title = track or item_name or station_name

        return {
            "source": source,
            "play_status": play_status,
            "title": title,
            "artist": artist,
            "album": album,
            "station_name": station_name,
            "art_url": art_url,
            "location": location,
            "item_name": item_name,
        }
    except ET.ParseError as err:
        LOGGER.warning("Failed to parse nowPlaying XML: %s", err)
        return {"source": "STANDBY", "play_status": "", "title": "", "artist": "",
                "album": "", "station_name": "", "art_url": "", "location": "", "item_name": ""}


def _parse_volume(xml_text: str) -> dict[str, Any]:
    """Parse volume XML into a dict."""
    try:
        root = ET.fromstring(xml_text)
        actual = root.findtext("actualvolume") or "0"
        target = root.findtext("targetvolume") or "0"
        muted_text = root.findtext("muteenabled") or "false"
        return {
            "actual": int(actual),
            "target": int(target),
            "muted": muted_text.lower() == "true",
        }
    except (ET.ParseError, ValueError) as err:
        LOGGER.warning("Failed to parse volume XML: %s", err)
        return {"actual": 0, "target": 0, "muted": False}


def _parse_presets(xml_text: str) -> list[dict[str, Any]]:
    """Parse presets XML into a list of dicts."""
    presets = []
    try:
        root = ET.fromstring(xml_text)
        for preset_elem in root.findall("preset"):
            preset_id = preset_elem.attrib.get("id", "0")
            content = preset_elem.find("ContentItem")
            if content is not None:
                presets.append({
                    "id": int(preset_id),
                    "source": content.attrib.get("source", ""),
                    "type": content.attrib.get("type", ""),
                    "location": content.attrib.get("location", ""),
                    "source_account": content.attrib.get("sourceAccount", ""),
                    "name": content.findtext("itemName") or f"Preset {preset_id}",
                    "art_url": content.findtext("containerArt") or "",
                })
    except ET.ParseError as err:
        LOGGER.warning("Failed to parse presets XML: %s", err)
    return presets


class SoundCorkCoordinator(DataUpdateCoordinator):
    """Coordinator that polls SoundCork for all speaker states."""

    def __init__(self, hass: HomeAssistant, base_url: str) -> None:
        """Initialise the coordinator."""
        self.base_url = base_url.rstrip("/")
        self.speakers: list[dict[str, Any]] = []
        self._session: aiohttp.ClientSession | None = None

        super().__init__(
            hass,
            LOGGER,
            name=DOMAIN,
            update_interval=timedelta(seconds=SCAN_INTERVAL_SECONDS),
        )

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession()
        return self._session

    async def async_shutdown(self) -> None:
        """Close the aiohttp session on shutdown."""
        if self._session and not self._session.closed:
            await self._session.close()
        await super().async_shutdown()

    async def _fetch_speakers(self) -> list[dict[str, Any]]:
        """Fetch speaker list from SoundCork."""
        session = await self._get_session()
        async with session.get(
            f"{self.base_url}/api/v1/speakers",
            timeout=aiohttp.ClientTimeout(total=10),
        ) as resp:
            resp.raise_for_status()
            return await resp.json()

    async def _fetch_now_playing(self, ip: str) -> dict[str, Any]:
        """Fetch now-playing state for one speaker."""
        session = await self._get_session()
        try:
            async with session.get(
                f"{self.base_url}/api/v1/speakers/{ip}/now-playing",
                timeout=aiohttp.ClientTimeout(total=5),
            ) as resp:
                text = await resp.text()
                return _parse_now_playing(text)
        except Exception as err:
            LOGGER.debug("now-playing fetch failed for %s: %s", ip, err)
            return {"source": "STANDBY", "play_status": "", "title": "", "artist": "",
                    "album": "", "station_name": "", "art_url": "", "location": "", "item_name": ""}

    async def _fetch_volume(self, ip: str) -> dict[str, Any]:
        """Fetch volume for one speaker."""
        session = await self._get_session()
        try:
            async with session.get(
                f"{self.base_url}/api/v1/speakers/{ip}/volume",
                timeout=aiohttp.ClientTimeout(total=5),
            ) as resp:
                text = await resp.text()
                return _parse_volume(text)
        except Exception as err:
            LOGGER.debug("volume fetch failed for %s: %s", ip, err)
            return {"actual": 0, "target": 0, "muted": False}

    async def _fetch_presets(self, ip: str) -> list[dict[str, Any]]:
        """Fetch presets for one speaker."""
        session = await self._get_session()
        try:
            async with session.get(
                f"{self.base_url}/api/v1/speakers/{ip}/presets",
                timeout=aiohttp.ClientTimeout(total=5),
            ) as resp:
                text = await resp.text()
                return _parse_presets(text)
        except Exception as err:
            LOGGER.debug("presets fetch failed for %s: %s", ip, err)
            return []

    async def _async_update_data(self) -> dict[str, Any]:
        """Fetch all speaker states. Called every SCAN_INTERVAL_SECONDS."""
        try:
            # Refresh speaker list on first run or if empty
            if not self.speakers:
                self.speakers = await self._fetch_speakers()

            data: dict[str, Any] = {}
            for speaker in self.speakers:
                ip = speaker["ipAddress"]
                now_playing, volume, presets = await self.hass.async_add_executor_job(
                    lambda _ip=ip: None  # placeholder - will use async below
                ) or (None, None, None)

                # Fetch concurrently
                import asyncio
                now_playing, volume, presets = await asyncio.gather(
                    self._fetch_now_playing(ip),
                    self._fetch_volume(ip),
                    self._fetch_presets(ip),
                )

                data[ip] = {
                    "speaker": speaker,
                    "now_playing": now_playing,
                    "volume": volume,
                    "presets": presets,
                }

            return data

        except aiohttp.ClientError as err:
            raise UpdateFailed(f"Error communicating with SoundCork: {err}") from err
        except Exception as err:
            raise UpdateFailed(f"Unexpected error updating SoundCork data: {err}") from err
