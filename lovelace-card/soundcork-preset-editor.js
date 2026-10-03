/**
 * SoundCork Card - Custom Lovelace Card
 * mode: player ? dynamic preset play buttons loaded live from SoundCork
 * mode: editor ? TuneIn search to update preset slots
 */
class SoundcorkPresetEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass = null;
    this._searchResults = [];
    this._currentPresets = [];
    this._selectedSlot = 1;
    this._loading = false;
    this._saving = false;
    this._playing = null;
    this._selectedSpeakers = null;
    this._activeTab = 'tunein';
    this._pandoraStations = [];
    this._pandoraRefreshing = false;
    this._podcastStatus = null;
    this._podcastLoading = false;
    this._podcastView = 'search';
    this._podcastQuery = '';
    this._podcastSearching = false;
    this._podcastShows = [];
    this._podcastStations = [];
    this._podcastShow = null;
    this._podcastEpisodes = [];
    this._podcastEpisodesLoading = false;
    this._podcastFavorites = [];
    this._tiPopular = [];
    this._pkShows = [];
    this._pkFilter = '';
    this._pkView = 'list';
    this._pkShow = null;
    this._pkEpisodes = [];
    this._pkLoading = false;
    this._pkFavorites = [];
    this._ihFavorites = [];
    this._ihQuery = '';
    this._ihSearching = false;
    this._ihShows = [];
    this._ihView = 'search';
    this._ihShow = null;
    this._ihEpisodes = [];
    this._ihEpisodesLoading = false;
    this._spStatus = null;
    this._spFavorites = [];
    this._spQuery = '';
    this._spSearching = false;
    this._spShows = [];
    this._spView = 'list';
    this._spShow = null;
    this._spEpisodes = [];
    this._spLoading = false;
    this._spPlaylist = []; // soundcork-managed editable playlist
    this._spQueueOpen = false;
    this._selectedSpeakers = null; // null means ALL
    this._message = null;
    this._initialized = false;
  }

  setConfig(config) {
    if (!config.soundcork_url) throw new Error("soundcork_url is required");
    this._config = config;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._initialized) {
      this._initialized = true;
      if (this._mode === "pandora") { this._loadPandora(); this._loadPresets(); }
      else if (this._mode === "podcast") { this._loadPodcastFavorites(); this._loadTuneinPopular(); }
      else if (this._mode === "pushkin") { this._loadPushkin(); }
      else if (this._mode === "iheart") { this._loadIheart(); }
      else if (this._mode === "spotify") { this._loadSpotify(); }
      else if (this._mode !== "speaker") { this._loadPresets(); }
    }
    if (this._mode === "speaker" || this._mode === "pandora") this._render();
  }

  get _mode() { return this._config.mode || "editor"; }
  get _baseUrl() { return (this._config.soundcork_url || "").replace(/\/$/, ""); }
  get _speakers() { return this._config.speakers || []; }

  _getSpeakerIps() {
    return this._speakers.map(id => {
      const state = this._hass && this._hass.states[id];
      if (!state || state.state === "unavailable") return null;
      return state.attributes.ip_address;
    }).filter(Boolean);
  }

  get _data() {
    return this._getSpeakerState();
  }

  _getSpeakerState() {
    // Read from HA entity state instead of polling SoundCork directly
    const entityId = this._speakers[0];
    if (!this._hass || !entityId) return null;
    const state = this._hass.states[entityId];
    if (!state) return null;
    const attrs = state.attributes;
    const isOff = state.state === "off" || state.state === "unavailable";
    return {
      now_playing: {
        source: isOff ? "STANDBY" : (attrs.source || ""),
        title: attrs.media_title || attrs.media_station || "",
        artist: attrs.media_artist || "",
        art_url: attrs.entity_picture ? (attrs.entity_picture.startsWith("http") ? attrs.entity_picture : `http://homeassistant.local:8123${attrs.entity_picture}`) : "",
        isOff: isOff,
      },
      volume: {
        actual: Math.round((attrs.volume_level || 0) * 100),
        muted: attrs.is_volume_muted || false,
      }
    };
  }

  async _loadPresets() {
    // Try each speaker in order until one responds - resilient to individual speakers being offline
    const ips = this._getSpeakerIps();
    for (const ip of ips) {
      try {
        const r = await fetch(`${this._baseUrl}/api/v1/speakers/${ip}/presets`, {signal: AbortSignal.timeout(4000)});
        if (!r.ok) continue;
        const doc = new DOMParser().parseFromString(await r.text(), "application/xml");
        const presets = [];
        doc.querySelectorAll("preset").forEach(p => {
          const ci = p.querySelector("ContentItem");
          if (ci) presets.push({
            id: parseInt(p.getAttribute("id")),
            name: ci.querySelector("itemName")?.textContent || `Preset ${p.getAttribute("id")}`,
            art: ci.querySelector("containerArt")?.textContent || "",
            source: ci.getAttribute("source") || "",
            location: ci.getAttribute("location") || "",
            type: ci.getAttribute("type") || "",
            sourceAccount: ci.getAttribute("sourceAccount") || "",
          });
        });
        if (presets.length > 0) {
          this._currentPresets = presets;
          this._render();
          return; // success - stop trying
        }
      } catch(e) {
        console.debug(`SoundCork: preset fetch failed for ${ip}, trying next...`);
      }
    }
    console.warn("SoundCork: could not load presets from any speaker");
  }

  _getTargetSpeakers() {
    const targetIds = (this._selectedSpeakers && this._selectedSpeakers.length > 0) ? this._selectedSpeakers : this._speakers;
    return targetIds.map(id => {
      const state = this._hass && this._hass.states[id];
      if (!state) return null;
      // Skip truly unavailable speakers (no HA entity data at all)
      if (state.state === "unavailable") return null;
      return { ip: state.attributes.ip_address, device_id: state.attributes.device_id };
    }).filter(s => s && s.ip && s.device_id);
  }

  async _reachable(ip) {
    try {
      const r = await fetch(`${this._baseUrl}/api/v1/speakers/${ip}/now-playing`, {signal: AbortSignal.timeout(800)});
      const text = await r.text();
      return r.ok && !text.includes("Cannot reach");
    } catch(e) { return false; }
  }

  _pickMasterIdx(reachable) {
    // Prefer Kitchen (always-on interior speaker) as zone master, same as
    // the preset flows - outdoor speakers like The Deck can drop offline
    // mid-session and take the whole zone down with them.
    const idx = reachable.findIndex(t => t.ip === "192.168.1.214");
    return idx >= 0 ? idx : 0;
  }

  async _playWithZone(xml) {
    const targets = this._getTargetSpeakers();
    if (!targets.length) return;
    // Filter to only reachable speakers before building zone
    const reachable = (await Promise.all(targets.map(async t => ({ ...t, up: await this._reachable(t.ip) })))).filter(t => t.up);
    if (!reachable.length) { console.warn("SoundCork: no reachable speakers"); return; }
    if (reachable.length === 1) {
      await fetch(`${this._baseUrl}/api/v1/speakers/${reachable[0].ip}/select`, {method:"POST",headers:{"Content-Type":"application/xml"},body:xml}).catch(()=>{});
    } else {
      // Clear stale zones first to avoid zombie master
      await Promise.all(reachable.map(t =>
        fetch(`${this._baseUrl}/api/v1/zone/clear/${t.ip}`, {method:"POST"}).catch(()=>{})
      ));
      await new Promise(r => setTimeout(r, 300));
      // Prefer Kitchen as master (always-on), else first reachable
      const kitchenIdx = reachable.findIndex(t => t.ip === "192.168.1.214");
      const masterIdx = kitchenIdx >= 0 ? kitchenIdx : 0;
      const master = reachable[masterIdx];
      const slaves = reachable.filter((_, i) => i !== masterIdx);
      // 1. Play on master FIRST so it has an active source (retry once)
      const waitForPlayZ = async (ip, polls) => {
        for (let attempt = 0; attempt < polls; attempt++) {
          await new Promise(r => setTimeout(r, 500));
          try {
            const npr = await fetch(`${this._baseUrl}/api/v1/speakers/${ip}/now-playing`, {signal: AbortSignal.timeout(800)});
            if ((await npr.text()).includes("PLAY_STATE")) return true;
          } catch(e) {}
        }
        return false;
      };
      await fetch(`${this._baseUrl}/api/v1/speakers/${master.ip}/select`, {method:"POST",headers:{"Content-Type":"application/xml"},body:xml}).catch(()=>{});
      let zMasterPlaying = await waitForPlayZ(master.ip, 20);
      if (!zMasterPlaying) {
        await fetch(`${this._baseUrl}/api/v1/speakers/${master.ip}/select`, {method:"POST",headers:{"Content-Type":"application/xml"},body:xml}).catch(()=>{});
        zMasterPlaying = await waitForPlayZ(master.ip, 20);
      }
      // 2. Only zone a confirmed playing master; else independent playback
      if (zMasterPlaying) {
        await fetch(`${this._baseUrl}/api/v1/zone/set`, {
          method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({ master_ip: master.ip, master_device_id: master.device_id, slaves: slaves })
        }).catch(()=>{});
      } else {
        console.warn("SoundCork: zone master never reached PLAY_STATE, independent playback");
        await Promise.all(slaves.map(t =>
          fetch(`${this._baseUrl}/api/v1/speakers/${t.ip}/select`, {method:"POST",headers:{"Content-Type":"application/xml"},body:xml}).catch(()=>{})
        ));
      }
    }
  }

  async _playPreset(preset) {
    if (this._playing) return;
    this._playing = preset.id;
    this._render();
    const targets = this._getTargetSpeakers();
    const reachable = (await Promise.all(
      targets.map(async t => ({ ...t, up: await this._reachable(t.ip) }))
    )).filter(t => t.up);
    if (!reachable.length) { this._playing = null; this._render(); return; }
    // 1. Clear any existing zones first to prevent zombie master
    await Promise.all(reachable.map(t =>
      fetch(`${this._baseUrl}/api/v1/zone/clear/${t.ip}`, {method:"POST"}).catch(()=>{})
    ));
    await new Promise(r => setTimeout(r, 300));
    if (reachable.length === 1) {
      // Single speaker - no zone needed
      await fetch(`${this._baseUrl}/api/v1/speakers/${reachable[0].ip}/key/PRESET_${preset.id}`, {method:"POST"}).catch(()=>{});
    } else {
      // Prefer Kitchen as master (always-on, reliable)
      const kitchenIdx = reachable.findIndex(t => t.ip === "192.168.1.214");
      const masterIdx = kitchenIdx >= 0 ? kitchenIdx : 0;
      const master = reachable[masterIdx];
      const slaves = reachable.filter((_, i) => i !== masterIdx);
      // 2. Play preset on master FIRST so it has an active source.
      //    Retry once if it doesn't start (cold standby can eat the first key).
      const waitForPlay = async (ip, polls) => {
        for (let attempt = 0; attempt < polls; attempt++) {
          await new Promise(r => setTimeout(r, 500));
          try {
            const npr = await fetch(`${this._baseUrl}/api/v1/speakers/${ip}/now-playing`, {signal: AbortSignal.timeout(800)});
            if ((await npr.text()).includes("PLAY_STATE")) return true;
          } catch(e) {}
        }
        return false;
      };
      await fetch(`${this._baseUrl}/api/v1/speakers/${master.ip}/key/PRESET_${preset.id}`, {method:"POST"}).catch(()=>{});
      let masterPlaying = await waitForPlay(master.ip, 20); // up to 10s for cold start
      if (!masterPlaying) {
        // Retry the preset key once, wait again
        await fetch(`${this._baseUrl}/api/v1/speakers/${master.ip}/key/PRESET_${preset.id}`, {method:"POST"}).catch(()=>{});
        masterPlaying = await waitForPlay(master.ip, 20);
      }
      // 3. Only zone a CONFIRMED playing master. Zoning a buffering/stuck master
      //    drops the whole group into INVALID_SOURCE.
      if (masterPlaying) {
        await fetch(`${this._baseUrl}/api/v1/zone/set`, {
          method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({ master_ip: master.ip, master_device_id: master.device_id, slaves })
        }).catch(()=>{});
      } else {
        // Master never started: fall back to independent playback on all
        // selected speakers so the user still gets music everywhere.
        console.warn("SoundCork: master never reached PLAY_STATE, falling back to independent playback");
        await Promise.all(slaves.map(t =>
          fetch(`${this._baseUrl}/api/v1/speakers/${t.ip}/key/PRESET_${preset.id}`, {method:"POST"}).catch(()=>{})
        ));
      }
    }
    this._playing = null;
    this._render();
  }

  _getTargetIps() {
    // If a subset of speakers is selected, use those; otherwise use all
    if (this._selectedSpeakers && this._selectedSpeakers.length > 0) {
      return this._selectedSpeakers
        .map(id => this._hass && this._hass.states[id] && this._hass.states[id].attributes.ip_address)
        .filter(Boolean);
    }
    return this._getSpeakerIps();
  }

  _getSpeakerNames() {
    return this._speakers.map(id => {
      const state = this._hass && this._hass.states[id];
      return { id, name: state ? (state.attributes.friendly_name || id.split(".")[1]) : id.split(".")[1] };
    });
  }

  async _turnOffAll() {
    // Clear zone on first (master) speaker before powering off
    const ips = this._getSpeakerIps();
    if (ips.length > 1) {
      await fetch(`${this._baseUrl}/api/v1/zone/clear/${ips[0]}`, { method:'POST' }).catch(()=>{});
      await new Promise(r => setTimeout(r, 200));
    }
    await Promise.all(ips.map(ip =>
      fetch(`${this._baseUrl}/api/v1/speakers/${ip}/power-off`, { method:"POST" }).catch(()=>{})
    ));
  }

  async _setVolumeAll(vol) {
    const xml = `<volume>${vol}</volume>`;
    await Promise.all(this._getSpeakerIps().map(ip =>
      fetch(`${this._baseUrl}/api/v1/speakers/${ip}/volume`, {
        method:"POST", headers:{"Content-Type":"application/xml"}, body:xml
      }).catch(()=>{})
    ));
  }

  async _loadPandora() {
    this._pandoraRefreshing = true;
    this._render();
    try {
      const r = await fetch(`${this._baseUrl}/api/v1/pandora/stations`);
      const data = await r.json();
      this._pandoraStations = data.stations || [];
    } catch(e) { console.warn('SoundCork: loadPandora failed', e); }
    this._pandoraRefreshing = false;
    this._render();
  }

  async _playPandora(station) {
    const xml = `<ContentItem source="PANDORA" location="${station.location}" sourceAccount="${station.sourceAccount}" isPresetable="true"></ContentItem>`;
    await this._playWithZone(xml);
  }

  async _storePresetOnSpeakers(ips, xml) {
    // Write a preset to every target speaker with a bounded per-request timeout
    // and one retry, and report back exactly which IPs succeeded vs failed.
    //
    // Root cause (found 2026-08-15): the three save flows below used to run
    // `fetch(...).catch(()=>{})` in a plain for-loop with NO timeout, only
    // incrementing a numeric `ok` counter. A single slow/flaky speaker (e.g.
    // the known Pooptown/Jefe Negro wifi reliability issue) could hang or
    // silently fail its fetch, and the only visible symptom was a generic
    // "Saved to 6/8 speakers" message (or, if the speaker had already been
    // filtered out earlier by _getSpeakerIps as unavailable, no indication
    // at all - the success message just said "Preset saved" with no count).
    // Either way there was no way to tell WHICH speakers were skipped without
    // manually checking each one, which is how the Radio LaB test silently
    // missed Pooptown and Downstairs. This now names the failures explicitly.
    const succeeded = [];
    const failed = [];
    for (const ip of ips) {
      let done = false;
      for (let attempt = 0; attempt < 2 && !done; attempt++) {
        try {
          const r = await fetch(`${this._baseUrl}/api/v1/speakers/${ip}/store-preset`, {
            method: "POST",
            headers: { "Content-Type": "application/xml" },
            body: xml,
            signal: AbortSignal.timeout(8000),
          });
          if (r.status < 400) { succeeded.push(ip); done = true; }
        } catch (e) { /* network error or timeout - fall through to retry */ }
      }
      if (!done) failed.push(ip);
    }
    return { succeeded, failed };
  }

    async _savePandoraPreset(station) {
    if (this._saving) return;
    const slot = this._selectedSlot;
    const ips = this._getSpeakerIps();
    if (!ips.length) { this._message = "No speakers reachable"; this._render(); return; }
    if (!this._confirmWrite(slot, station.name, ips)) return;
    this._saving = true; this._message = null; this._render();
    const xml = `<preset id="${slot}"><ContentItem source="PANDORA" location="${station.location}" sourceAccount="${station.sourceAccount}" isPresetable="true"><itemName>${this._esc(station.name)}</itemName><containerArt>${this._esc(station.art)}</containerArt></ContentItem></preset>`;
    const { succeeded, failed } = await this._storePresetOnSpeakers(ips, xml);
    this._saving = false;
    await this._loadPresets();
    if (!failed.length) {
      this._message = `Preset ${slot} saved: ${station.name}`;
      this._render();
      this._offerUndo(succeeded);
    } else {
      const failedNames = this._targetSpeakerNames(failed);
      this._message = `Saved to ${succeeded.length}/${ips.length} speakers - FAILED: ${failedNames.join(", ")}`;
      this._render();
      setTimeout(() => { this._message=null; this._render(); }, 8000);
    }
  }


  async _search(query) {
    if (!query.trim()) return;
    this._loading = true; this._searchResults = []; this._render();
    try {
      const data = await (await fetch(`${this._baseUrl}/api/v1/tunein/search?q=${encodeURIComponent(query)}&include_podcasts=1`)).json();
      const results = [];
      const process = item => {
        if (item.element==="outline" && item.type==="audio" && item.guide_id)
          results.push({ guide_id:item.guide_id, name:item.text, subtext:item.subtext||"", image:item.image||"", bitrate:item.bitrate||"", unsupported:item.key==="unavailable" });
        if (item.children) item.children.forEach(process);
      };
      if (data.body) data.body.forEach(process);
      this._searchResults = results;
    } catch(e) { console.warn("SoundCork search failed", e); }
    this._loading = false; this._render();
  }

    async _savePreset(station) {
    if (this._saving) return;
    const slot = this._selectedSlot;
    const ips = this._getTargetIps();
    if (!ips.length) { this._message = "No target speakers reachable/selected"; this._render(); return; }
    if (!this._confirmWrite(slot, station.name, ips)) return;
    this._saving = true; this._message = null; this._render();
    let artUrl = station.image || "";
    try {
      const dd = await (await fetch(`${this._baseUrl}/api/v1/tunein/describe?id=${station.guide_id}`)).json();
      if (dd.body?.[0]?.logo) artUrl = dd.body[0].logo;
    } catch(_) {}
    const isPodcast = station.guide_id && station.guide_id.startsWith("p");
    const location = isPodcast ? `/v1/playback/show/${station.guide_id}` : `/v1/playback/station/${station.guide_id}`;
    const xml = `<preset id="${slot}"><ContentItem source="TUNEIN" type="stationurl" location="${location}" isPresetable="true"><itemName>${this._esc(station.name)}</itemName><containerArt>${this._esc(artUrl)}</containerArt></ContentItem></preset>`;
    const { succeeded, failed } = await this._storePresetOnSpeakers(ips, xml);
    this._saving = false;
    await this._loadPresets();
    if (!failed.length) {
      this._message = `Preset ${slot} saved: ${station.name} (TuneIn - Bose's TuneIn backend is unreliable, verify it actually plays)`;
      this._render();
      this._offerUndo(succeeded);
    } else {
      const failedNames = this._targetSpeakerNames(failed);
      this._message = `Saved to ${succeeded.length}/${ips.length} speakers - FAILED: ${failedNames.join(", ")}`;
      this._render();
      setTimeout(() => { this._message=null; this._render(); }, 8000);
    }
  }


  _targetSpeakerNames(ips) {
    const names = this._getSpeakerNames();
    return ips.map(ip => {
      const match = this._speakers.find(id => {
        const s = this._hass && this._hass.states[id];
        return s && s.attributes.ip_address === ip;
      });
      const n = names.find(x => x.id === match);
      return n ? n.name : ip;
    });
  }

  _confirmWrite(slot, newName, ips) {
    const targetNames = this._targetSpeakerNames(ips);
    const current = this._currentPresets.find(p => p.id === slot);
    const currentName = current ? current.name : "(empty)";
    const speakerLabel = ips.length > 1 ? `${ips.length} speakers (${targetNames.join(", ")})` : (targetNames[0] || ips[0]);
    let msg = `Replace preset ${slot} on ${speakerLabel}?\n\nCurrently: ${currentName}\nNew: ${newName}`;
    // Surface any speaker that was silently dropped from `ips` before we ever
    // got here (unavailable in HA, or missing an ip_address attribute) - this
    // is the pre-flight half of the 2026-08-15 "saved to 6/8 speakers" bug.
    // Without this, a speaker excluded by _getSpeakerIps()/_getTargetIps()
    // never showed up anywhere: the confirm dialog and success message both
    // only ever knew about the already-filtered `ips` list.
    const requestedIds = (this._selectedSpeakers && this._selectedSpeakers.length > 0) ? this._selectedSpeakers : this._speakers;
    const excludedIds = requestedIds.filter(id => {
      const s = this._hass && this._hass.states[id];
      const ip = s && s.attributes.ip_address;
      return !ip || !ips.includes(ip);
    });
    if (excludedIds.length) {
      const excludedNames = excludedIds.map(id => {
        const s = this._hass && this._hass.states[id];
        return s ? (s.attributes.friendly_name || id.split(".")[1]) : id.split(".")[1];
      });
      msg += `\n\nWARNING: skipping ${excludedNames.join(", ")} (unavailable right now) - preset will NOT be updated there.`;
    }
    return window.confirm(msg);
  }

  async _restoreLastBackup(ips) {
    let ok = 0;
    for (const ip of ips) {
      try {
        const r = await fetch(`${this._baseUrl}/api/v1/speakers/${ip}/presets/restore`, { method:"POST", headers:{"Content-Type":"application/json"}, body:"{}" });
        if (r.ok) ok++;
      } catch(_) {}
    }
    this._message = ok === ips.length ? `Undone - restored previous presets on ${ok} speaker${ok===1?"":"s"}` : `Restored ${ok}/${ips.length} speakers`;
    await this._loadPresets();
    this._render();
    setTimeout(() => { this._message=null; this._render(); }, 5000);
  }

  _offerUndo(ips) {
    this._message = `${this._message || "Saved."} <button class="undo-link" id="undo-btn">Undo</button>`;
    this._render();
    const btn = this.shadowRoot.getElementById("undo-btn");
    btn?.addEventListener("click", () => this._restoreLastBackup(ips));
    setTimeout(() => { this._message=null; this._render(); }, 15000);
  }

  async _saveRadioPreset(name, streamUrl, artUrl) {
    if (this._saving) return;
    const slot = this._selectedSlot;
    const ips = this._getTargetIps();
    if (!ips.length) { this._message = "No target speakers reachable/selected"; this._render(); return; }
    if (!streamUrl || !streamUrl.trim()) { this._message = "Stream URL is required"; this._render(); return; }
    if (!this._confirmWrite(slot, name || streamUrl, ips)) return;
    this._saving = true; this._message = null; this._render();
    const xml = `<preset id="${slot}"><ContentItem source="LOCAL_INTERNET_RADIO" type="stationurl" location="${this._esc(streamUrl.trim())}" isPresetable="true"><itemName>${this._esc(name || streamUrl)}</itemName><containerArt>${this._esc(artUrl||"")}</containerArt></ContentItem></preset>`;
    const { succeeded, failed } = await this._storePresetOnSpeakers(ips, xml);
    this._saving = false;
    await this._loadPresets();
    if (!failed.length) {
      this._message = `Preset ${slot} saved: ${name || streamUrl}`;
      this._render();
      this._offerUndo(succeeded);
    } else {
      const failedNames = this._targetSpeakerNames(failed);
      this._message = `Saved to ${succeeded.length}/${ips.length} speakers - FAILED: ${failedNames.join(", ")}`;
      this._render();
      setTimeout(() => { this._message=null; this._render(); }, 8000);
    }
  }

  _esc(s) { return (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

  _styles() { return `
    :host{display:block}
    ha-card{background:var(--card-background-color);border-radius:12px;overflow:hidden}
    .card{padding:16px}
    h3{margin:0 0 14px;font-size:12px;font-weight:700;color:var(--secondary-text-color);text-transform:uppercase;letter-spacing:.1em}
    .spk-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
    .spk-chip{padding:4px 12px;border-radius:20px;border:1.5px solid transparent;cursor:pointer;font-size:12px;font-weight:600;color:var(--primary-text-color);background:var(--secondary-background-color,#2a2a40);transition:border-color .15s,background .15s}
    .spk-chip.active{border-color:var(--primary-color);background:rgba(3,169,244,.15);color:var(--primary-color)}
    .spk-chip:hover:not(.active){border-color:rgba(255,255,255,.2)}
    .spk-chip-all{background:rgba(3,169,244,.1)}
    .spk-chip.active{border-color:var(--primary-color);background:rgba(3,169,244,.15);color:var(--primary-color)}
    .spk-chip:hover:not(.active){border-color:rgba(255,255,255,.2)}
    .preset-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px}
    .preset-btn{position:relative;height:100px;border-radius:10px;overflow:hidden;cursor:pointer;border:none;padding:0;background:#333;transition:transform .12s,opacity .12s;width:100%}
    .preset-btn:active{transform:scale(.97)}
    .preset-btn.playing{box-shadow:0 0 0 2px var(--primary-color)}
    .preset-btn img{width:100%;height:100%;object-fit:cover;display:block}
    .overlay{position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,.75) 0%,transparent 60%)}
    .label{position:absolute;bottom:7px;left:9px;right:9px;color:#fff;font-size:12px;font-weight:700;text-shadow:0 1px 4px rgba(0,0,0,.9);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left}
    .slot-badge{position:absolute;top:7px;left:7px;background:rgba(0,0,0,.55);color:#fff;font-size:10px;font-weight:700;padding:2px 6px;border-radius:10px}
    .spin{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.4);font-size:22px}
    .off-btn{width:100%;padding:9px;border-radius:8px;border:none;background:rgba(200,0,0,.25);color:#ff6b6b;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;transition:background .15s}
    .off-btn:hover{background:rgba(200,0,0,.4)}
    .pandora-list{display:flex;flex-direction:column;gap:6px;max-height:340px;overflow-y:auto}
    .pandora-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
    .refresh-btn{background:none;border:none;cursor:pointer;color:var(--secondary-text-color);font-size:16px;padding:2px 6px;border-radius:6px;transition:color .15s,background .15s}
    .refresh-btn:hover{color:var(--primary-color);background:rgba(3,169,244,.1)}
    .refresh-btn.spinning{animation:spin .7s linear infinite}
    @keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
    .pandora-item{display:flex;align-items:center;gap:10px;padding:8px;border-radius:8px;background:var(--secondary-background-color,#2a2a40)}
    .pandora-art{width:48px;height:48px;border-radius:6px;overflow:hidden;flex-shrink:0;background:#333;display:flex;align-items:center;justify-content:center;font-size:24px}
    .pandora-art img{width:100%;height:100%;object-fit:cover}
    .pandora-info{flex:1;min-width:0}
    .pandora-name{font-size:13px;font-weight:600;color:var(--primary-text-color);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .pandora-acct{font-size:11px;color:var(--secondary-text-color)}
    .pandora-acct-header{font-size:11px;font-weight:700;color:var(--primary-color);text-transform:uppercase;letter-spacing:.08em;padding:8px 0 4px;border-top:1px solid var(--divider-color,#333);margin-top:4px}
    .pandora-acct-header:first-child{border-top:none;margin-top:0;padding-top:0}
    .play-btn{padding:5px 10px;border-radius:6px;border:none;background:rgba(3,169,244,.2);color:var(--primary-color);font-size:12px;font-weight:600;cursor:pointer}
    .play-btn:hover{background:rgba(3,169,244,.35)}
    .vol-row{display:flex;align-items:center;gap:8px;padding:12px 0 10px}
    .vol-label{font-size:12px;color:var(--secondary-text-color);flex-shrink:0}
    .vol-bar-row{display:flex;align-items:center;gap:8px;margin-bottom:6px}
    .vol-bar-track{flex:1;height:6px;border-radius:4px;background:var(--divider-color,#444);overflow:hidden}
    .vol-bar-fill{height:100%;border-radius:4px;background:var(--primary-color,#03a9f4);transition:width .2s ease}
    .vol-bar-pct{font-size:12px;color:var(--primary-text-color);flex-shrink:0;width:36px;text-align:right;font-weight:600}
    .vol-btn{flex:1;padding:16px 0;border-radius:8px;border:none;background:var(--secondary-background-color,#2a2a40);color:var(--primary-text-color);font-size:20px;font-weight:700;cursor:pointer;transition:background .15s}
    .vol-btn:hover{background:rgba(3,169,244,.2);color:var(--primary-color)}
    .vol-btn:active{transform:scale(.95)}
    .spk-card{padding:14px 16px 16px}
    .spk-top{display:flex;align-items:center;gap:14px;margin-bottom:12px}
    .spk-art{width:80px;height:80px;border-radius:10px;overflow:hidden;flex-shrink:0;background:#333;display:flex;align-items:center;justify-content:center;font-size:32px}
    .spk-art img{width:100%;height:100%;object-fit:cover}
    .spk-info{flex:1;min-width:0}
    .spk-name{font-size:15px;font-weight:700;color:var(--primary-text-color);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:3px}
    .spk-track{font-size:12px;color:var(--secondary-text-color);overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
    .spk-power{background:none;border:none;cursor:pointer;padding:6px;color:var(--secondary-text-color);font-size:22px;flex-shrink:0}
    .spk-power:hover{color:var(--primary-text-color)}
    .chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px}
    .chip{display:flex;align-items:center;gap:6px;padding:5px 10px 5px 6px;border-radius:20px;background:var(--secondary-background-color,#2a2a40);border:1.5px solid transparent;cursor:pointer;font-size:12px;color:var(--primary-text-color);transition:border-color .15s,background .15s}
    .chip img{width:20px;height:20px;border-radius:50%;object-fit:cover}
    .chip.active{border-color:var(--primary-color);background:rgba(3,169,244,.15)}
    .chip:hover:not(.active){border-color:rgba(255,255,255,.2)}
    .search-row{display:flex;gap:8px;margin-bottom:12px}
    .search-input{flex:1;padding:8px 12px;border-radius:8px;border:1.5px solid var(--divider-color,#333);background:var(--secondary-background-color,#2a2a40);color:var(--primary-text-color);font-size:14px;outline:none}
    .search-input:focus{border-color:var(--primary-color)}
    .search-btn{padding:8px 16px;border-radius:8px;border:none;background:var(--primary-color,#03a9f4);color:#fff;font-size:14px;font-weight:600;cursor:pointer;transition:opacity .15s}
    .search-btn:hover{opacity:.85}
    .search-btn:disabled{opacity:.5;cursor:not-allowed}
    .message{padding:8px 12px;border-radius:8px;background:rgba(3,169,244,.15);color:var(--primary-text-color);font-size:13px;margin-bottom:10px}
    .results{display:flex;flex-direction:column;gap:6px;max-height:340px;overflow-y:auto}
    .result{display:flex;align-items:center;gap:10px;padding:8px;border-radius:8px;background:var(--secondary-background-color,#2a2a40);transition:background .15s}
    .result:hover{background:rgba(255,255,255,.06)}
    .result.unsupported{opacity:.5}
    .result-art{width:42px;height:42px;border-radius:6px;overflow:hidden;flex-shrink:0;background:#333;display:flex;align-items:center;justify-content:center}
    .result-art img{width:100%;height:100%;object-fit:cover}
    .result-info{flex:1;min-width:0}
    .result-name{font-size:13px;font-weight:600;color:var(--primary-text-color);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .result-sub{font-size:11px;color:var(--secondary-text-color);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .badge{background:rgba(255,100,0,.3);color:#ff9060;font-size:10px;padding:1px 5px;border-radius:4px;font-weight:400}
    .save-btn{flex-shrink:0;padding:5px 12px;border-radius:6px;border:none;background:var(--primary-color,#03a9f4);color:#fff;font-size:12px;font-weight:600;cursor:pointer;transition:opacity .15s}
    .save-btn:hover{opacity:.85}
    .loading{text-align:center;padding:16px;color:var(--secondary-text-color);font-size:13px}
    .empty{text-align:center;padding:20px;color:var(--secondary-text-color);font-size:13px}
    .podcast-card{padding:16px}
    .podcast-url-row{display:flex;gap:8px;margin-bottom:12px}
    .podcast-url-input{flex:1;padding:8px 12px;border-radius:8px;border:1.5px solid var(--divider-color,#333);background:var(--secondary-background-color,#2a2a40);color:var(--primary-text-color);font-size:13px;outline:none;font-family:monospace}
    .podcast-url-input:focus{border-color:var(--primary-color)}
    .podcast-play-btn{padding:8px 18px;border-radius:8px;border:none;background:var(--primary-color,#03a9f4);color:#fff;font-size:14px;font-weight:600;cursor:pointer;transition:opacity .15s;flex-shrink:0}
    .podcast-play-btn:hover{opacity:.85}
    .podcast-play-btn:disabled{opacity:.5;cursor:not-allowed}
    .podcast-status{padding:10px 12px;border-radius:8px;font-size:13px;margin-bottom:10px}
    .podcast-status.success{background:rgba(3,169,244,.15);color:var(--primary-text-color)}
    .podcast-status.error{background:rgba(200,0,0,.2);color:#ff6b6b}
    .podcast-status.loading{background:rgba(255,255,255,.05);color:var(--secondary-text-color)}
    .podcast-hint{font-size:11px;color:var(--secondary-text-color);margin-bottom:14px;line-height:1.5}
    .pandora-btns{display:flex;gap:6px;flex-shrink:0}
    .play-btn{padding:5px 10px;border-radius:6px;border:none;background:rgba(3,169,244,.2);color:var(--primary-color);font-size:12px;font-weight:600;cursor:pointer}
    .play-btn:hover{background:rgba(3,169,244,.35)}
    .warn-banner{background:rgba(255,150,0,.12);border:1px solid rgba(255,150,0,.35);color:var(--primary-text-color);font-size:11px;line-height:1.5;padding:8px 10px;border-radius:8px;margin-bottom:10px}
    .undo-link{background:none;border:1px solid currentColor;color:inherit;border-radius:6px;padding:2px 8px;margin-left:8px;font-size:11px;cursor:pointer;font-weight:700}
    .undo-link:hover{opacity:.8}
    .fav-row{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
    .fav-chip{display:flex;align-items:center;gap:6px;padding:4px 10px 4px 5px;border-radius:20px;background:var(--secondary-background-color,#2a2a40);border:1.5px solid transparent;cursor:pointer;font-size:12px;font-weight:600;color:var(--primary-text-color);max-width:170px;overflow:hidden;transition:border-color .15s}
    .fav-chip span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .fav-chip img{width:22px;height:22px;border-radius:50%;object-fit:cover;flex-shrink:0}
    .fav-chip:hover{border-color:var(--primary-color)}
    .fav-btn{background:none;border:none;cursor:pointer;font-size:17px;color:var(--secondary-text-color);padding:4px 6px;flex-shrink:0;transition:color .15s}
    .fav-btn:hover,.fav-btn.active{color:#ff5c8a}
    .ep-header{display:flex;align-items:center;gap:10px;margin-bottom:12px}
    .back-btn{background:var(--secondary-background-color,#2a2a40);border:none;cursor:pointer;color:var(--primary-text-color);font-size:16px;padding:8px 12px;border-radius:8px;flex-shrink:0}
    .back-btn:hover{background:rgba(3,169,244,.2)}
    .fav-del{background:none;border:none;cursor:pointer;font-size:14px;color:var(--secondary-text-color);padding:4px 6px;flex-shrink:0;transition:color .15s}
    .sp-add{flex-shrink:0;width:26px;height:26px;border-radius:50%;border:1.5px solid var(--divider-color,#555);background:transparent;color:var(--primary-text-color);font-size:15px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s,border-color .15s,color .15s}
    .sp-add:hover{border-color:var(--primary-color);color:var(--primary-color)}
    .sp-add.added{background:var(--primary-color,#03a9f4);border-color:var(--primary-color,#03a9f4);color:#fff}
    .npq-num{flex-shrink:0;width:18px;text-align:center;font-size:11px;font-weight:700;color:var(--secondary-text-color)}
    .npq-del{flex-shrink:0;background:none;border:none;cursor:pointer;font-size:13px;color:var(--secondary-text-color);padding:4px 6px;transition:color .15s}
    .npq-del:hover{color:#ff6b6b}
    .np-bar{background:var(--secondary-background-color,#2a2a40);border-radius:10px;padding:12px;margin-bottom:12px}
    .np-top{display:flex;align-items:center;gap:10px;margin-bottom:10px}
    .np-art{width:46px;height:46px;border-radius:6px;overflow:hidden;flex-shrink:0;background:#333;display:flex;align-items:center;justify-content:center;font-size:22px}
    .np-art img{width:100%;height:100%;object-fit:cover}
    .np-meta{flex:1;min-width:0}
    .np-title{font-size:13px;font-weight:700;color:var(--primary-text-color);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .np-artist{font-size:11px;color:var(--secondary-text-color);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .np-seek{height:8px;border-radius:5px;background:var(--divider-color,#444);cursor:pointer;overflow:hidden}
    .np-seek-fill{height:100%;background:var(--primary-color,#03a9f4);border-radius:5px;transition:width .25s linear;pointer-events:none}
    .np-times{display:flex;justify-content:space-between;font-size:10px;color:var(--secondary-text-color);margin:4px 1px 8px}
    .np-controls{display:flex;align-items:center;justify-content:center;gap:18px}
    .np-btn{background:none;border:none;cursor:pointer;color:var(--primary-text-color);font-size:20px;padding:4px 8px;border-radius:6px;transition:color .15s,background .15s}
    .np-btn:hover{color:var(--primary-color)}
    .np-play{font-size:26px}
    .np-queue-btn{font-size:16px}
    .np-queue-btn.active{color:var(--primary-color)}
    .np-queue{margin-top:10px}
    .np-queue:empty{margin-top:0}
    .npq-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--secondary-text-color);padding:6px 0 4px;border-top:1px solid var(--divider-color,#444)}
    .npq-list{max-height:220px;overflow-y:auto;display:flex;flex-direction:column;gap:4px}
    .npq-row{display:flex;align-items:center;gap:8px;padding:4px 0}
    .npq-art{width:32px;height:32px;border-radius:4px;overflow:hidden;flex-shrink:0;background:#333;display:flex;align-items:center;justify-content:center;font-size:14px}
    .npq-art img{width:100%;height:100%;object-fit:cover}
    .npq-info{flex:1;min-width:0}
    .npq-title{font-size:12px;color:var(--primary-text-color);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .npq-sub{font-size:10px;color:var(--secondary-text-color);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .npq-note{font-size:10px;color:var(--secondary-text-color);margin-top:8px;line-height:1.4;font-style:italic}
    .fav-del:hover{color:#ff6b6b}
    .pod-adv{margin-top:12px}
    .pod-adv summary{font-size:11px;color:var(--secondary-text-color);cursor:pointer;margin-bottom:8px}
  `; }

  _renderSpeaker() {
    const data = this._data;
    const np = data ? data.now_playing : {};
    const vol = data ? data.volume : {};
    const isOff = !np || !np.source || np.source === "STANDBY" || np.isOff;
    const art = np && np.art_url ? `<img src="${np.art_url}" alt=""/>` : "??";
    const track = np && np.title ? np.title : (isOff ? "Off" : "--");
    const artist = np && np.artist ? np.artist : "";
    const volVal = vol ? vol.actual : 0;
    const name = this._config.speaker_name || "Speaker";
    return `<div class="spk-card">
      <div class="spk-top">
        <div class="spk-art">${art}</div>
        <div class="spk-info">
          <div class="spk-name">${name}</div>
          <div class="spk-track">${track}${artist ? " &middot; " + artist : ""}</div>
        </div>
        <button class="spk-power" id="spk-pwr" title="Power">${isOff ? "&#x23FB;" : "&#x23FC;"}</button>
      </div>
      <div class="vol-row">
        <span class="vol-label">&#x1F50A;</span>
        <input class="vol-slider" id="vol-slider" type="range" min="0" max="100" value="${volVal}" ${isOff ? "disabled" : ""}/>
        <span class="vol-val" id="vol-val">${volVal}%</span>
      </div>
    </div>`;
  }

  async _playPodcast(url) {
    const targets = this._getTargetSpeakers();
    if (!targets.length) { this._podcastStatus = {type:'error', msg:'No reachable speakers selected'}; this._render(); return; }
    const reachable = (await Promise.all(targets.map(async t => ({ ...t, up: await this._reachable(t.ip) })))).filter(t => t.up);
    if (!reachable.length) { this._podcastStatus = {type:'error', msg:'No speakers are reachable'}; this._render(); return; }
    const masterIdx = this._pickMasterIdx(reachable);
    const master = reachable[masterIdx], slaves = reachable.filter((_, i) => i !== masterIdx);
    this._podcastLoading = true;
    this._podcastStatus = {type:'loading', msg:'Looking up episode...'};
    this._render();
    try {
      const r = await fetch(`${this._baseUrl}/api/v1/tunein/play-podcast`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ url, master_ip: master.ip, master_device_id: master.device_id, slaves })
      });
      const data = await r.json();
      if (r.ok && data.success) {
        this._podcastStatus = {type:'success', msg:`Playing: ${data.title} on ${data.speakers} speaker${data.speakers>1?'s':''}`};
      } else {
        this._podcastStatus = {type:'error', msg: data.detail || 'Playback failed'};
      }
    } catch(e) {
      this._podcastStatus = {type:'error', msg:'Network error - check SoundCork connection'};
    }
    this._podcastLoading = false;
    // Don't re-render on success - preserve the URL in the input
    if (this._podcastStatus && this._podcastStatus.type !== 'success') this._render();
    else {
      // Just update the status display without full re-render
      const statusEl = this.shadowRoot.querySelector('.podcast-status');
      if (!statusEl && this._podcastStatus) {
        const row = this.shadowRoot.querySelector('.podcast-url-row');
        if (row) {
          const div = document.createElement('div');
          div.className = 'podcast-status ' + this._podcastStatus.type;
          div.textContent = this._podcastStatus.msg;
          row.parentNode.insertBefore(div, row);
        }
      } else if (statusEl) {
        statusEl.className = 'podcast-status ' + this._podcastStatus.type;
        statusEl.textContent = this._podcastStatus.msg;
      }
    }
    setTimeout(() => { this._podcastStatus = null; const el = this.shadowRoot.querySelector('.podcast-status'); if(el) el.remove(); }, 8000);
  }

  async _loadPodcastFavorites() {
    try {
      const r = await fetch(`${this._baseUrl}/api/v1/podcasts/favorites`, {signal: AbortSignal.timeout(5000)});
      const data = await r.json();
      this._podcastFavorites = data.favorites || [];
    } catch(e) { console.warn('SoundCork: loadPodcastFavorites failed', e); }
    this._render();
  }

  async _loadTuneinPopular() {
    try {
      const data = await (await fetch(`${this._baseUrl}/api/v1/tunein/popular`, {signal: AbortSignal.timeout(25000)})).json();
      this._tiPopular = data.shows || [];
    } catch(e) { console.warn('SoundCork: tunein popular failed', e); }
    this._render();
  }

  _isFavorite(guideId) { return this._podcastFavorites.some(f => f.guide_id === guideId); }

  async _toggleFavorite(item) {
    try {
      let r;
      if (this._isFavorite(item.guide_id)) {
        r = await fetch(`${this._baseUrl}/api/v1/podcasts/favorites/${item.guide_id}`, {method:'DELETE'});
      } else {
        r = await fetch(`${this._baseUrl}/api/v1/podcasts/favorites`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ guide_id: item.guide_id, name: item.name, image: item.image || '' })
        });
      }
      const data = await r.json();
      this._podcastFavorites = data.favorites || [];
    } catch(e) { console.warn('SoundCork: toggleFavorite failed', e); }
    this._render();
  }

  async _addFavoriteByUrl(url) {
    if (!url || !url.trim()) return;
    this._podcastStatus = {type:'loading', msg:'Resolving URL...'};
    this._render();
    try {
      const r = await fetch(`${this._baseUrl}/api/v1/tunein/resolve-url`, {
        method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ url: url.trim() })
      });
      const data = await r.json();
      if (!r.ok || !data.guide_id) throw new Error(data.detail || 'Could not resolve that URL');
      const name = data.kind === 'episode' && data.show_title ? `${data.show_title}: ${data.name}` : data.name;
      const fr = await fetch(`${this._baseUrl}/api/v1/podcasts/favorites`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ guide_id: data.guide_id, name, image: data.image || '' })
      });
      const fd = await fr.json();
      this._podcastFavorites = fd.favorites || [];
      this._podcastStatus = {type:'success', msg:`Added ${data.kind}: ${name}`};
    } catch(e) {
      this._podcastStatus = {type:'error', msg: e.message || 'Could not add favorite'};
    }
    this._render();
    setTimeout(() => { if (this._podcastStatus) { this._podcastStatus = null; this._render(); } }, 6000);
  }

  async _podcastSearch(query) {
    if (!query.trim()) return;
    this._podcastQuery = query;
    this._podcastSearching = true; this._podcastShows = []; this._podcastStations = []; this._render();
    try {
      const data = await (await fetch(`${this._baseUrl}/api/v1/tunein/search?q=${encodeURIComponent(query)}`)).json();
      const shows = [], stations = [];
      const process = item => {
        const gid = item.guide_id || '';
        // p = podcast show, s = live station; m = artist/music noise - skip
        if (gid.startsWith('p') && item.text)
          shows.push({ guide_id: gid, name: item.text, subtext: item.subtext || '', image: item.image || '' });
        else if (gid.startsWith('s') && item.type === 'audio')
          stations.push({ guide_id: gid, name: item.text || gid, subtext: item.subtext || '', image: item.image || '', unsupported: item.key === 'unavailable' });
        if (item.children) item.children.forEach(process);
      };
      if (data.body) data.body.forEach(process);
      this._podcastShows = shows; this._podcastStations = stations;
    } catch(e) { console.warn('SoundCork podcast search failed', e); }
    this._podcastSearching = false; this._render();
  }

  async _openEpisodes(show) {
    this._podcastShow = show;
    this._podcastView = 'episodes';
    this._podcastEpisodes = [];
    this._podcastEpisodesLoading = true;
    this._render();
    try {
      const data = await (await fetch(`${this._baseUrl}/api/v1/tunein/episodes?id=${show.guide_id}`)).json();
      this._podcastEpisodes = data.episodes || [];
    } catch(e) { console.warn('SoundCork: episode list failed', e); }
    this._podcastEpisodesLoading = false;
    this._render();
  }

  _fmtDuration(sec) {
    const s = parseInt(sec);
    if (!s || isNaN(s)) return '';
    const m = Math.round(s / 60);
    return m >= 60 ? `${Math.floor(m/60)}h ${m%60}m` : `${m}m`;
  }

  async _playGuideId(guideId, title, image) {
    const targets = this._getTargetSpeakers();
    if (!targets.length) { this._podcastStatus = {type:'error', msg:'No reachable speakers selected'}; this._render(); return; }
    this._podcastLoading = true;
    this._podcastStatus = {type:'loading', msg:`Starting: ${title}...`};
    this._render();
    const reachable = (await Promise.all(targets.map(async t => ({ ...t, up: await this._reachable(t.ip) })))).filter(t => t.up);
    if (!reachable.length) { this._podcastLoading = false; this._podcastStatus = {type:'error', msg:'No speakers are reachable'}; this._render(); return; }
    const masterIdx = this._pickMasterIdx(reachable);
    const master = reachable[masterIdx], slaves = reachable.filter((_, i) => i !== masterIdx);
    try {
      const r = await fetch(`${this._baseUrl}/api/v1/tunein/play-podcast`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ guide_id: guideId, title, image: image || '', master_ip: master.ip, master_device_id: master.device_id, slaves })
      });
      const data = await r.json();
      if (r.ok && data.success) {
        const confirmNote = data.play_confirmed === false ? ' (speaker has not confirmed playback yet)' : '';
        this._podcastStatus = {type:'success', msg:`Playing: ${data.title} on ${data.speakers} speaker${data.speakers>1?'s':''}${confirmNote}`};
      } else {
        this._podcastStatus = {type:'error', msg: data.detail || 'Playback failed'};
      }
    } catch(e) {
      this._podcastStatus = {type:'error', msg:'Network error - check SoundCork connection'};
    }
    this._podcastLoading = false;
    this._render();
    setTimeout(() => { if (this._podcastStatus) { this._podcastStatus = null; this._render(); } }, 8000);
  }

  async _loadPushkin() {
    try {
      const [sr, fr] = await Promise.all([
        fetch(`${this._baseUrl}/api/v1/pushkin/shows`, {signal: AbortSignal.timeout(15000)}),
        fetch(`${this._baseUrl}/api/v1/podcasts/favorites?provider=pushkin`, {signal: AbortSignal.timeout(5000)}),
      ]);
      this._pkShows = (await sr.json()).shows || [];
      this._pkFavorites = (await fr.json()).favorites || [];
    } catch(e) { console.warn('SoundCork: loadPushkin failed', e); }
    this._render();
  }

  _pkIsFavorite(slug) { return this._pkFavorites.some(f => f.guide_id === slug); }

  async _pkToggleFavorite(show) {
    const slug = show.slug || show.guide_id;
    try {
      let r;
      if (this._pkIsFavorite(slug)) {
        r = await fetch(`${this._baseUrl}/api/v1/podcasts/favorites/${slug}?provider=pushkin`, {method:'DELETE'});
      } else {
        r = await fetch(`${this._baseUrl}/api/v1/podcasts/favorites`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ provider:'pushkin', guide_id: slug, name: show.name, image: show.image || '' })
        });
      }
      this._pkFavorites = (await r.json()).favorites || [];
    } catch(e) { console.warn('SoundCork: pushkin favorite failed', e); }
    this._render();
  }

  async _pkOpenEpisodes(show) {
    this._pkShow = { slug: show.slug || show.guide_id, name: show.name, image: show.image || '' };
    this._pkView = 'episodes';
    this._pkEpisodes = [];
    this._pkLoading = true;
    this._render();
    try {
      const data = await (await fetch(`${this._baseUrl}/api/v1/pushkin/episodes?show=${encodeURIComponent(this._pkShow.slug)}`, {signal: AbortSignal.timeout(25000)})).json();
      this._pkEpisodes = data.episodes || [];
      if (data.show) this._pkShow = { slug: this._pkShow.slug, name: data.show.name || this._pkShow.name, image: data.show.image || this._pkShow.image };
    } catch(e) { console.warn('SoundCork: pushkin episodes failed', e); }
    this._pkLoading = false;
    this._render();
  }

  async _pkPlayLatest(show) {
    const slug = show.slug || show.guide_id;
    this._podcastStatus = {type:'loading', msg:`Finding latest episode of ${show.name}...`};
    this._render();
    try {
      const data = await (await fetch(`${this._baseUrl}/api/v1/pushkin/episodes?show=${encodeURIComponent(slug)}`, {signal: AbortSignal.timeout(25000)})).json();
      const ep = (data.episodes || [])[0];
      if (!ep) throw new Error('No episodes found');
      await this._playStreamUrl(ep.audio_url, `${(data.show && data.show.name) || show.name}: ${ep.title}`, ep.image || (data.show && data.show.image) || '');
    } catch(e) {
      this._podcastStatus = {type:'error', msg: e.message || 'Could not find episodes'};
      this._render();
      setTimeout(() => { if (this._podcastStatus) { this._podcastStatus = null; this._render(); } }, 8000);
    }
  }

  async _playStreamUrl(streamUrl, title, image) {
    const targets = this._getTargetSpeakers();
    if (!targets.length) { this._podcastStatus = {type:'error', msg:'No reachable speakers selected'}; this._render(); return; }
    this._podcastLoading = true;
    this._podcastStatus = {type:'loading', msg:`Starting: ${title}...`};
    this._render();
    const reachable = (await Promise.all(targets.map(async t => ({ ...t, up: await this._reachable(t.ip) })))).filter(t => t.up);
    if (!reachable.length) { this._podcastLoading = false; this._podcastStatus = {type:'error', msg:'No speakers are reachable'}; this._render(); return; }
    const masterIdx = this._pickMasterIdx(reachable);
    const master = reachable[masterIdx], slaves = reachable.filter((_, i) => i !== masterIdx);
    try {
      const r = await fetch(`${this._baseUrl}/api/v1/play-stream`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ stream_url: streamUrl, title, image: image || '', master_ip: master.ip, master_device_id: master.device_id, slaves })
      });
      const data = await r.json();
      if (r.ok && data.success) {
        const note = data.play_confirmed === false ? ' (speaker has not confirmed playback yet)' : '';
        this._podcastStatus = {type:'success', msg:`Playing: ${data.title} on ${data.speakers} speaker${data.speakers>1?'s':''}${note}`};
      } else {
        this._podcastStatus = {type:'error', msg: data.detail || 'Playback failed'};
      }
    } catch(e) {
      this._podcastStatus = {type:'error', msg:'Network error - check SoundCork connection'};
    }
    this._podcastLoading = false;
    this._render();
    setTimeout(() => { if (this._podcastStatus) { this._podcastStatus = null; this._render(); } }, 8000);
  }

  _pkShowRowsHtml() {
    const filter = this._pkFilter.trim().toLowerCase();
    const shows = filter ? this._pkShows.filter(s => s.name.toLowerCase().includes(filter)) : this._pkShows;
    return shows.length ? shows.map((s) => {
      const i = this._pkShows.indexOf(s);
      return `
      <div class="result">
        <div class="result-art"><div style="font-size:20px">&#x1F399;</div></div>
        <div class="result-info"><div class="result-name">${this._esc(s.name)}</div></div>
        <button class="fav-btn ${this._pkIsFavorite(s.slug)?'active':''} pk-show-fav" data-i="${i}" title="Favorite">${this._pkIsFavorite(s.slug)?'&#x2665;':'&#x2661;'}</button>
        <div class="pandora-btns"><button class="play-btn pk-show-play" data-i="${i}" ${this._podcastLoading?'disabled':''} title="Play latest episode">&#x25B6;</button><button class="play-btn pk-show-eps" data-i="${i}">Episodes</button></div>
      </div>`;}).join('') : (this._pkShows.length ? '<div class="empty">No shows match</div>' : '<div class="loading">Loading Pushkin catalog...</div>');
  }

  _pkBindShowRows() {
    const list = this.shadowRoot.getElementById('pk-show-list');
    if (!list) return;
    list.querySelectorAll('.pk-show-fav').forEach(b => b.addEventListener('click', () => { const s = this._pkShows[parseInt(b.dataset.i)]; if (s) this._pkToggleFavorite(s); }));
    list.querySelectorAll('.pk-show-play').forEach(b => b.addEventListener('click', () => { const s = this._pkShows[parseInt(b.dataset.i)]; if (s) this._pkPlayLatest(s); }));
    list.querySelectorAll('.pk-show-eps').forEach(b => b.addEventListener('click', () => { const s = this._pkShows[parseInt(b.dataset.i)]; if (s) this._pkOpenEpisodes(s); }));
  }

  _pkRefreshShowList() {
    const list = this.shadowRoot.getElementById('pk-show-list');
    if (!list) return;
    list.innerHTML = this._pkShowRowsHtml();
    this._pkBindShowRows();
  }

  async _loadIheart() {
    try {
      const r = await fetch(`${this._baseUrl}/api/v1/podcasts/favorites?provider=iheart`, {signal: AbortSignal.timeout(5000)});
      this._ihFavorites = (await r.json()).favorites || [];
    } catch(e) { console.warn('SoundCork: loadIheart failed', e); }
    this._render();
  }

  _ihIsFavorite(id) { return this._ihFavorites.some(f => f.guide_id === id); }

  async _ihToggleFavorite(show) {
    const id = show.guide_id;
    try {
      let r;
      if (this._ihIsFavorite(id)) {
        r = await fetch(`${this._baseUrl}/api/v1/podcasts/favorites/${id}?provider=iheart`, {method:'DELETE'});
      } else {
        r = await fetch(`${this._baseUrl}/api/v1/podcasts/favorites`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ provider:'iheart', guide_id: id, name: show.name, image: show.image || '' })
        });
      }
      this._ihFavorites = (await r.json()).favorites || [];
    } catch(e) { console.warn('SoundCork: iheart favorite failed', e); }
    this._render();
  }

  async _ihSearch(query) {
    if (!query.trim()) return;
    this._ihQuery = query;
    this._ihSearching = true; this._ihShows = []; this._render();
    try {
      const data = await (await fetch(`${this._baseUrl}/api/v1/iheart/search?q=${encodeURIComponent(query)}`, {signal: AbortSignal.timeout(15000)})).json();
      this._ihShows = data.shows || [];
    } catch(e) { console.warn('SoundCork: iheart search failed', e); }
    this._ihSearching = false; this._render();
  }

  async _ihOpenEpisodes(show) {
    this._ihShow = { guide_id: show.guide_id, name: show.name, image: show.image || '' };
    this._ihView = 'episodes';
    this._ihEpisodes = [];
    this._ihEpisodesLoading = true;
    this._render();
    try {
      const data = await (await fetch(`${this._baseUrl}/api/v1/iheart/episodes?id=${encodeURIComponent(show.guide_id)}`, {signal: AbortSignal.timeout(25000)})).json();
      this._ihEpisodes = data.episodes || [];
      if (data.show) this._ihShow = { guide_id: this._ihShow.guide_id, name: data.show.name || this._ihShow.name, image: data.show.image || this._ihShow.image };
    } catch(e) { console.warn('SoundCork: iheart episodes failed', e); }
    this._ihEpisodesLoading = false;
    this._render();
  }

  async _ihPlayEpisode(ep, showName, showImage) {
    this._podcastStatus = {type:'loading', msg:`Resolving: ${ep.title}...`};
    this._render();
    try {
      const r = await fetch(`${this._baseUrl}/api/v1/iheart/episode-stream?id=${encodeURIComponent(ep.episode_id)}`, {signal: AbortSignal.timeout(15000)});
      const data = await r.json();
      if (!r.ok || !data.stream_url) throw new Error(data.detail || 'Could not resolve episode stream');
      await this._playStreamUrl(data.stream_url, `${showName}: ${ep.title}`, ep.image || data.image || showImage || '');
    } catch(e) {
      this._podcastStatus = {type:'error', msg: e.message || 'Could not resolve episode'};
      this._render();
      setTimeout(() => { if (this._podcastStatus) { this._podcastStatus = null; this._render(); } }, 8000);
    }
  }

  async _ihPlayLatest(show) {
    this._podcastStatus = {type:'loading', msg:`Finding latest episode of ${show.name}...`};
    this._render();
    try {
      const data = await (await fetch(`${this._baseUrl}/api/v1/iheart/episodes?id=${encodeURIComponent(show.guide_id)}`, {signal: AbortSignal.timeout(25000)})).json();
      const ep = (data.episodes || [])[0];
      if (!ep) throw new Error('No episodes found');
      await this._ihPlayEpisode(ep, (data.show && data.show.name) || show.name, (data.show && data.show.image) || show.image || '');
    } catch(e) {
      this._podcastStatus = {type:'error', msg: e.message || 'Could not find episodes'};
      this._render();
      setTimeout(() => { if (this._podcastStatus) { this._podcastStatus = null; this._render(); } }, 8000);
    }
  }

  async _loadSpotify() {
    try {
      const [sr, fr, pr] = await Promise.all([
        fetch(`${this._baseUrl}/api/v1/spotify/status`, {signal: AbortSignal.timeout(10000)}),
        fetch(`${this._baseUrl}/api/v1/podcasts/favorites?provider=spotify`, {signal: AbortSignal.timeout(5000)}),
        fetch(`${this._baseUrl}/api/v1/spotify/playlist`, {signal: AbortSignal.timeout(5000)}),
      ]);
      this._spStatus = await sr.json();
      this._spFavorites = (await fr.json()).favorites || [];
      this._spPlaylist = (await pr.json()).items || [];
    } catch(e) { console.warn('SoundCork: loadSpotify failed', e); }
    this._render();
  }

  _spIsFavorite(uri) { return this._spFavorites.some(f => f.guide_id === uri); }

  async _spToggleFavorite(show) {
    const uri = show.uri || show.guide_id;
    try {
      let r;
      if (this._spIsFavorite(uri)) {
        r = await fetch(`${this._baseUrl}/api/v1/podcasts/favorites/${encodeURIComponent(uri)}?provider=spotify`, {method:'DELETE'});
      } else {
        r = await fetch(`${this._baseUrl}/api/v1/podcasts/favorites`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ provider:'spotify', guide_id: uri, name: show.name, image: show.image || '' })
        });
      }
      this._spFavorites = (await r.json()).favorites || [];
    } catch(e) { console.warn('SoundCork: spotify favorite failed', e); }
    this._render();
  }

  async _spSearch(query) {
    if (!query.trim()) return;
    this._spQuery = query;
    this._spSearching = true; this._spShows = []; this._render();
    try {
      const r = await fetch(`${this._baseUrl}/api/v1/spotify/search?q=${encodeURIComponent(query)}&type=show`, {signal: AbortSignal.timeout(15000)});
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || 'Spotify search failed');
      this._spShows = data.shows || [];
    } catch(e) {
      console.warn('SoundCork: spotify search failed', e);
      this._podcastStatus = {type:'error', msg: e.message || 'Spotify search failed'};
      setTimeout(() => { if (this._podcastStatus) { this._podcastStatus = null; this._render(); } }, 8000);
    }
    this._spSearching = false; this._render();
  }

  async _spOpenEpisodes(show) {
    this._spShow = { uri: show.uri || show.guide_id, name: show.name, image: show.image || '' };
    this._spView = 'episodes';
    this._spEpisodes = [];
    this._spLoading = true;
    this._render();
    try {
      const data = await (await fetch(`${this._baseUrl}/api/v1/spotify/episodes?id=${encodeURIComponent(this._spShow.uri)}`, {signal: AbortSignal.timeout(15000)})).json();
      this._spEpisodes = data.episodes || [];
    } catch(e) { console.warn('SoundCork: spotify episodes failed', e); }
    this._spLoading = false;
    this._render();
  }

  async _spPlay(uri, title, image) {
    return this._spPlayBody({ uri, title, image: image || '' }, title);
  }

  // --- Transport: live now-playing bar with play/pause/next/prev/seek ---

  _spStartPolling() {
    if (this._spPollTimer) return;
    const tick = async () => {
      if (this._mode !== 'spotify' || !this.isConnected) { this._spStopPolling(); return; }
      try {
        const r = await fetch(`${this._baseUrl}/api/v1/spotify/playback`, {signal: AbortSignal.timeout(6000)});
        this._spNow = await r.json();
        this._spNowAt = Date.now();
      } catch(e) { /* keep last state on a transient failure */ }
      this._spUpdateNowBar();
    };
    tick();
    // poll server for truth every 4s; a 1s local ticker interpolates the bar
    this._spPollTimer = setInterval(tick, 4000);
    this._spTickTimer = setInterval(() => this._spUpdateNowBar(), 1000);
  }

  _spStopPolling() {
    if (this._spPollTimer) { clearInterval(this._spPollTimer); this._spPollTimer = null; }
    if (this._spTickTimer) { clearInterval(this._spTickTimer); this._spTickTimer = null; }
  }

  _spNowProgress() {
    const n = this._spNow;
    if (!n || !n.playing) return n ? (n.progress_ms || 0) : 0;
    // interpolate between 4s polls so the bar moves every second
    return Math.min((n.progress_ms || 0) + (Date.now() - (this._spNowAt || Date.now())), n.duration_ms || 0);
  }

  _fmtClock(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(s / 60), ss = String(s % 60).padStart(2, '0');
    return m >= 60 ? `${Math.floor(m/60)}:${String(m%60).padStart(2,'0')}:${ss}` : `${m}:${ss}`;
  }

  _spUpdateNowBar() {
    const wrap = this.shadowRoot && this.shadowRoot.getElementById('sp-now');
    if (!wrap) return;
    const n = this._spNow;
    if (!n || !n.title) { wrap.innerHTML = ''; return; }
    const pos = this._spNowProgress(), dur = n.duration_ms || 0;
    const pct = dur ? Math.min(100, (pos / dur) * 100) : 0;
    const build = !wrap.querySelector('.np-bar');
    if (build) {
      wrap.innerHTML =
        '<div class="np-bar">' +
          '<div class="np-top">' +
            '<div class="np-art" id="np-art"></div>' +
            '<div class="np-meta"><div class="np-title" id="np-title"></div><div class="np-artist" id="np-artist"></div></div>' +
          '</div>' +
          '<div class="np-seek" id="np-seek"><div class="np-seek-fill" id="np-seek-fill"></div></div>' +
          '<div class="np-times"><span id="np-elapsed"></span><span id="np-total"></span></div>' +
          '<div class="np-controls">' +
            '<button class="np-btn" id="np-prev" title="Previous">&#x23EE;</button>' +
            '<button class="np-btn np-play" id="np-playpause" title="Play/Pause"></button>' +
            '<button class="np-btn" id="np-next" title="Next">&#x23ED;</button>' +
            '<button class="np-btn np-queue-btn" id="np-queue-btn" title="Queue">&#x2630;</button>' +
          '</div>' +
          '<div class="np-queue" id="np-queue"></div>' +
        '</div>';
      wrap.querySelector('#np-prev').addEventListener('click', () => this._spControl('previous'));
      wrap.querySelector('#np-next').addEventListener('click', () => this._spControl('next'));
      wrap.querySelector('#np-playpause').addEventListener('click', () => this._spControl(this._spNow && this._spNow.playing ? 'pause' : 'play'));
      wrap.querySelector('#np-queue-btn').addEventListener('click', () => this._spToggleQueue());
      wrap.querySelector('#np-seek').addEventListener('click', (e) => {
        const d = this._spNow && this._spNow.duration_ms; if (!d) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        this._spControl('seek', Math.round(frac * d));
      });
    }
    const qbtn = wrap.querySelector('#np-queue-btn');
    if (qbtn) qbtn.classList.toggle('active', !!this._spQueueOpen);
    if (build && this._spQueueOpen) this._spRenderQueue();
    wrap.querySelector('#np-art').innerHTML = n.image ? `<img src="${this._esc(n.image)}" alt=""/>` : '&#x1F3A7;';
    wrap.querySelector('#np-title').textContent = n.title;
    wrap.querySelector('#np-artist').textContent = n.artist || '';
    wrap.querySelector('#np-seek-fill').style.width = pct + '%';
    wrap.querySelector('#np-elapsed').textContent = this._fmtClock(pos);
    wrap.querySelector('#np-total').textContent = dur ? this._fmtClock(dur) : '';
    wrap.querySelector('#np-playpause').innerHTML = n.playing ? '&#x23F8;' : '&#x25B6;';
  }

  async _spToggleQueue() {
    this._spQueueOpen = !this._spQueueOpen;
    if (this._spQueueOpen) await this._spLoadPlaylist();
    this._spRenderQueue();
    const qbtn = this.shadowRoot && this.shadowRoot.querySelector('#np-queue-btn');
    if (qbtn) qbtn.classList.toggle('active', this._spQueueOpen);
  }

  _spRenderQueue() {
    const panel = this.shadowRoot && this.shadowRoot.getElementById('np-queue');
    if (!panel) return;
    if (!this._spQueueOpen) { panel.innerHTML = ''; return; }
    const items = this._spPlaylist || [];
    const rows = items.length ? items.map((it, idx) => `
      <div class="npq-row">
        <div class="npq-num">${idx+1}</div>
        <div class="npq-art">${it.image?`<img src="${this._esc(it.image)}" alt=""/>`:'&#x1F3A7;'}</div>
        <div class="npq-info"><div class="npq-title">${this._esc(it.title)}</div><div class="npq-sub">${this._esc(it.artist||'')}${this._fmtDuration(Math.round((it.duration_ms||0)/1000))?' &middot; '+this._fmtDuration(Math.round((it.duration_ms||0)/1000)):''}</div></div>
        <button class="npq-del" data-uri="${this._esc(it.uri)}" title="Remove">&#x2715;</button>
      </div>`).join('') : '<div class="empty" style="padding:8px 0">Your playlist is empty - add episodes with the + button</div>';
    panel.innerHTML =
      '<div class="npq-head"><span>Playlist' + (items.length?` (${items.length})`:'') + '</span>' +
      (items.length ? '<div class="pandora-btns"><button class="play-btn npq-clear">Clear all</button><button class="search-btn npq-playall" ' + (this._podcastLoading?'disabled':'') + '>&#x25B6; Play all</button></div>' : '') +
      '</div>' +
      `<div class="npq-list">${rows}</div>`;
    panel.querySelectorAll('.npq-del').forEach(b => b.addEventListener('click', () => this._spRemoveFromPlaylist(b.dataset.uri)));
    const clr = panel.querySelector('.npq-clear'); if (clr) clr.addEventListener('click', () => this._spClearPlaylist());
    const pa = panel.querySelector('.npq-playall'); if (pa) pa.addEventListener('click', () => this._spPlayPlaylist());
  }

  async _spControl(action, positionMs) {
    // optimistic UI so the button/bar respond instantly
    if (this._spNow) {
      if (action === 'pause') this._spNow.playing = false;
      else if (action === 'play') { this._spNow.playing = true; this._spNowAt = Date.now(); }
      else if (action === 'seek' && positionMs != null) { this._spNow.progress_ms = positionMs; this._spNowAt = Date.now(); }
      this._spUpdateNowBar();
    }
    try {
      const body = { action };
      if (action === 'seek') body.position_ms = positionMs;
      await fetch(`${this._baseUrl}/api/v1/spotify/control`, {
        method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)
      });
    } catch(e) { /* next poll reconciles */ }
    // re-sync shortly after (next/prev change the track)
    setTimeout(async () => {
      try {
        const r = await fetch(`${this._baseUrl}/api/v1/spotify/playback`, {signal: AbortSignal.timeout(6000)});
        this._spNow = await r.json(); this._spNowAt = Date.now(); this._spUpdateNowBar();
      } catch(e) {}
    }, action === 'seek' ? 400 : 700);
  }

  disconnectedCallback() { this._spStopPolling(); }

  // --- Soundcork-managed playlist (add/remove/clear, authoritative) ---
  // A real editable queue the user builds by hand, held server-side. Unlike
  // Spotify's own queue it has no autoplay padding and supports per-item
  // removal. "Play all" sends the ordered list to Spotify as one uris[] batch.

  async _spLoadPlaylist() {
    try {
      const r = await fetch(`${this._baseUrl}/api/v1/spotify/playlist`, {signal: AbortSignal.timeout(6000)});
      this._spPlaylist = (await r.json()).items || [];
    } catch(e) { this._spPlaylist = this._spPlaylist || []; }
  }

  _spInPlaylist(uri) { return (this._spPlaylist || []).some(i => i.uri === uri); }

  async _spAddToPlaylist(ep) {
    try {
      const r = await fetch(`${this._baseUrl}/api/v1/spotify/playlist/add`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ uri: ep.uri, title: ep.title, artist: (this._spShow && this._spShow.name) || ep.artist || '', image: ep.image || (this._spShow && this._spShow.image) || '', duration_ms: ep.duration_ms || (ep.duration_seconds ? ep.duration_seconds*1000 : 0) })
      });
      this._spPlaylist = (await r.json()).items || [];
    } catch(e) {}
    this._spRefreshAddButtons();
    if (this._spQueueOpen) this._spRenderQueue();
  }

  async _spRemoveFromPlaylist(uri) {
    try {
      const r = await fetch(`${this._baseUrl}/api/v1/spotify/playlist/remove`, {
        method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ uri })
      });
      this._spPlaylist = (await r.json()).items || [];
    } catch(e) {}
    this._spRenderQueue();
    this._spRefreshAddButtons();
  }

  async _spClearPlaylist() {
    try {
      const r = await fetch(`${this._baseUrl}/api/v1/spotify/playlist/clear`, {method:'POST'});
      this._spPlaylist = (await r.json()).items || [];
    } catch(e) {}
    this._spRenderQueue();
    this._spRefreshAddButtons();
  }

  // reflect add/remove on the episode rows' +/check buttons without a re-render
  _spRefreshAddButtons() {
    if (!this.shadowRoot) return;
    this.shadowRoot.querySelectorAll('.sp-add').forEach(b => {
      const inList = this._spInPlaylist(b.dataset.uri);
      b.classList.toggle('added', inList);
      b.innerHTML = inList ? '&#x2713;' : '&#x2b;';
      b.title = inList ? 'In playlist (tap to remove)' : 'Add to playlist';
    });
  }

  async _spPlayPlaylist() {
    const targets = this._getTargetSpeakers();
    if (!targets.length) { this._podcastStatus = {type:'error', msg:'No reachable speakers selected'}; this._render(); return; }
    this._podcastLoading = true;
    this._podcastStatus = {type:'loading', msg:'Starting your playlist...'};
    this._render();
    const reachable = (await Promise.all(targets.map(async t => ({ ...t, up: await this._reachable(t.ip) })))).filter(t => t.up);
    if (!reachable.length) { this._podcastLoading = false; this._podcastStatus = {type:'error', msg:'No speakers are reachable'}; this._render(); return; }
    const mi = this._pickMasterIdx(reachable);
    const master = reachable[mi], slaves = reachable.filter((_, i) => i !== mi);
    try {
      const r = await fetch(`${this._baseUrl}/api/v1/spotify/playlist/play`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ master_ip: master.ip, master_device_id: master.device_id, slaves })
      });
      const data = await r.json();
      this._podcastStatus = (r.ok && data.success)
        ? {type:'success', msg:`Playing ${data.queued} from your playlist on ${data.speakers} speaker${data.speakers>1?'s':''}`}
        : {type:'error', msg: data.detail || 'Playback failed'};
    } catch(e) { this._podcastStatus = {type:'error', msg:'Network error - check SoundCork connection'}; }
    this._podcastLoading = false;
    this._render();
    setTimeout(() => { if (this._podcastStatus) { this._podcastStatus = null; this._render(); } }, 8000);
  }

  async _spPlayBody(payload, label) {
    const targets = this._getTargetSpeakers();
    if (!targets.length) { this._podcastStatus = {type:'error', msg:'No reachable speakers selected'}; this._render(); return false; }
    this._podcastLoading = true;
    this._podcastStatus = {type:'loading', msg:`Starting: ${label}...`};
    this._render();
    const reachable = (await Promise.all(targets.map(async t => ({ ...t, up: await this._reachable(t.ip) })))).filter(t => t.up);
    if (!reachable.length) { this._podcastLoading = false; this._podcastStatus = {type:'error', msg:'No speakers are reachable'}; this._render(); return false; }
    const masterIdx = this._pickMasterIdx(reachable);
    const master = reachable[masterIdx], slaves = reachable.filter((_, i) => i !== masterIdx);
    let ok = false;
    try {
      const r = await fetch(`${this._baseUrl}/api/v1/spotify/play`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ ...payload, master_ip: master.ip, master_device_id: master.device_id, slaves })
      });
      const data = await r.json();
      if (r.ok && data.success) {
        ok = true;
        const note = data.play_confirmed === false ? ' (speaker has not confirmed playback yet)' : '';
        const q = data.queued > 1 ? `Playing ${data.queued} episodes in order` : `Playing: ${data.title}`;
        this._podcastStatus = {type:'success', msg:`${q} on ${data.speakers} speaker${data.speakers>1?'s':''}${note}`};
      } else {
        this._podcastStatus = {type:'error', msg: data.detail || 'Playback failed'};
      }
    } catch(e) {
      this._podcastStatus = {type:'error', msg:'Network error - check SoundCork connection'};
    }
    this._podcastLoading = false;
    this._render();
    setTimeout(() => { if (this._podcastStatus) { this._podcastStatus = null; this._render(); } }, 8000);
    return ok;
  }

  _render() {
    if (this._mode === "podcast") {
      const speakerNames = this._getSpeakerNames();
      const allSelected = !this._selectedSpeakers || this._selectedSpeakers.length === 0;
      const chipsHtml = '<div class="spk-chips"><span class="spk-chip spk-chip-all ' + (allSelected?'active':'') + '" data-spk="all">All</span>' +
        speakerNames.map(s => '<span class="spk-chip ' + (!allSelected && this._selectedSpeakers.includes(s.id)?'active':'') + '" data-spk="' + s.id + '">' + s.name + '</span>').join('') + '</div>';
      const statusHtml = this._podcastStatus ? `<div class="podcast-status ${this._podcastStatus.type}">${this._podcastStatus.msg}</div>` : '';

      let bodyHtml;
      if (this._podcastView === 'episodes' && this._podcastShow) {
        const show = this._podcastShow;
        const fav = this._isFavorite(show.guide_id);
        const eps = this._podcastEpisodesLoading
          ? '<div class="loading">Loading episodes...</div>'
          : this._podcastEpisodes.length ? this._podcastEpisodes.map((ep, i) => `
            <div class="result">
              <div class="result-art">${ep.image?`<img src="${this._esc(ep.image)}" alt=""/>`:'<div style="font-size:20px">&#x1F3A7;</div>'}</div>
              <div class="result-info">
                <div class="result-name">${this._esc(ep.title)}</div>
                <div class="result-sub">${this._esc(ep.date)}${this._fmtDuration(ep.duration_seconds)?' &middot; '+this._fmtDuration(ep.duration_seconds):''}</div>
              </div>
              <button class="play-btn ep-play" data-i="${i}" ${this._podcastLoading?'disabled':''}>&#x25B6; Play</button>
            </div>`).join('') : '<div class="empty">No episodes found</div>';
        bodyHtml = `
          <div class="ep-header">
            <button class="back-btn" id="pod-back" title="Back to search">&#x2190;</button>
            <div class="result-art">${show.image?`<img src="${this._esc(show.image)}" alt=""/>`:'&#x1F399;'}</div>
            <div class="result-info"><div class="result-name">${this._esc(show.name)}</div><div class="result-sub">Recent episodes</div></div>
            <button class="fav-btn ${fav?'active':''}" id="pod-fav" title="${fav?'Remove favorite':'Save favorite'}">${fav?'&#x2665;':'&#x2661;'}</button>
          </div>
          <div class="results">${eps}</div>`;
      } else {
        const favRows = this._podcastFavorites.map((f, i) => {
          const kind = f.guide_id.startsWith('p') ? 'show' : f.guide_id.startsWith('t') ? 'episode' : 'station';
          const actionBtn = kind === 'show'
            ? `<div class="pandora-btns"><button class="play-btn fav-play" data-i="${i}" ${this._podcastLoading?'disabled':''} title="Play latest episode">&#x25B6; Play</button><button class="play-btn fav-eps" data-i="${i}">Episodes</button></div>`
            : `<button class="play-btn fav-play" data-i="${i}" ${this._podcastLoading?'disabled':''}>&#x25B6; Play</button>`;
          return `<div class="result">
            <div class="result-art">${f.image?`<img src="${this._esc(f.image)}" alt=""/>`:'<div style="font-size:20px">&#x1F3A7;</div>'}</div>
            <div class="result-info"><div class="result-name">${this._esc(f.name)}</div><div class="result-sub">${kind}</div></div>
            ${actionBtn}
            <button class="fav-del" data-i="${i}" title="Remove favorite">&#x2715;</button>
          </div>`;
        }).join('');
        const favsHtml = `
          <div class="pandora-acct-header">Podcast Favorites</div>
          <div class="search-row">
            <input class="search-input" id="fav-url" type="text" placeholder="Add by TuneIn URL (tun.in or tunein.com)" spellcheck="false" autocomplete="off"/>
            <button class="search-btn" id="fav-add" ${this._podcastLoading?'disabled':''}>Add</button>
          </div>
          ${this._podcastFavorites.length ? `<div class="results" style="max-height:230px;margin-bottom:10px">${favRows}</div>` : '<div class="empty" style="padding:6px 0 12px">No favorites yet - paste a TuneIn URL above or &#x2661; a search result below</div>'}
          <div class="pandora-acct-header">Search TuneIn</div>`;
        let resultsHtml = '';
        if (this._podcastSearching) resultsHtml = '<div class="loading">Searching TuneIn...</div>';
        else if (this._podcastShows.length || this._podcastStations.length) {
          if (this._podcastShows.length) {
            resultsHtml += '<div class="pandora-acct-header">Podcasts</div>';
            resultsHtml += this._podcastShows.map((s, i) => `
              <div class="result">
                <div class="result-art">${s.image?`<img src="${this._esc(s.image)}" alt=""/>`:'<div style="font-size:20px">&#x1F399;</div>'}</div>
                <div class="result-info"><div class="result-name">${this._esc(s.name)}</div>${s.subtext?`<div class="result-sub">${this._esc(s.subtext)}</div>`:''}</div>
                <button class="fav-btn ${this._isFavorite(s.guide_id)?'active':''} show-fav" data-i="${i}" title="Favorite">${this._isFavorite(s.guide_id)?'&#x2665;':'&#x2661;'}</button>
                <div class="pandora-btns"><button class="play-btn show-play" data-i="${i}" ${this._podcastLoading?'disabled':''} title="Play latest episode">&#x25B6;</button><button class="play-btn show-eps" data-i="${i}">Episodes</button></div>
              </div>`).join('');
          }
          if (this._podcastStations.length) {
            resultsHtml += '<div class="pandora-acct-header">Live Stations</div>';
            resultsHtml += this._podcastStations.map((s, i) => `
              <div class="result ${s.unsupported?'unsupported':''}">
                <div class="result-art">${s.image?`<img src="${this._esc(s.image)}" alt=""/>`:'<div style="font-size:20px">&#x1F4FB;</div>'}</div>
                <div class="result-info"><div class="result-name">${this._esc(s.name)}</div>${s.subtext?`<div class="result-sub">${this._esc(s.subtext)}</div>`:''}</div>
                <button class="fav-btn ${this._isFavorite(s.guide_id)?'active':''} st-fav" data-i="${i}" title="Favorite">${this._isFavorite(s.guide_id)?'&#x2665;':'&#x2661;'}</button>
                <button class="play-btn st-play" data-i="${i}" ${this._podcastLoading||s.unsupported?'disabled':''}>&#x25B6; Play</button>
              </div>`).join('');
          }
        } else if (this._podcastQuery && !this._podcastSearching) resultsHtml = '<div class="empty">No results</div>';
        else if (this._tiPopular.length) {
          resultsHtml = '<div class="pandora-acct-header">Popular Shows</div>' + this._tiPopular.map((s, i) => `
              <div class="result">
                <div class="result-art">${s.image?`<img src="${this._esc(s.image)}" alt=""/>`:'<div style="font-size:20px">&#x1F399;</div>'}</div>
                <div class="result-info"><div class="result-name">${this._esc(s.name)}</div></div>
                <button class="fav-btn ${this._isFavorite(s.guide_id)?'active':''} pop-fav" data-i="${i}" title="Favorite">${this._isFavorite(s.guide_id)?'&#x2665;':'&#x2661;'}</button>
                <div class="pandora-btns"><button class="play-btn pop-play" data-i="${i}" ${this._podcastLoading?'disabled':''} title="Play latest episode">&#x25B6;</button><button class="play-btn pop-eps" data-i="${i}">Episodes</button></div>
              </div>`).join('');
        }
        bodyHtml = `
          ${favsHtml}
          <div class="search-row">
            <input class="search-input" id="pod-search" type="text" placeholder="Search podcasts &amp; stations (e.g. The Daily)" value="${this._esc(this._podcastQuery)}"/>
            <button class="search-btn" id="pod-search-btn" ${this._podcastSearching?'disabled':''}>${this._podcastSearching?'...':'Search'}</button>
          </div>
          <div class="results">${resultsHtml}</div>
          <details class="pod-adv"><summary>Play from a TuneIn URL</summary>
            <div class="podcast-url-row">
              <input class="podcast-url-input" id="podcast-url" type="text" placeholder="e.g. http://tun.in/tLU13Y" spellcheck="false" autocomplete="off"/>
              <button class="podcast-play-btn" id="podcast-play" ${this._podcastLoading?'disabled':''}>${this._podcastLoading?'...':'Play'}</button>
            </div>
          </details>`;
      }

      this.shadowRoot.innerHTML = `<style>${this._styles()}</style><ha-card><div class="podcast-card">
        <h3>TuneIn-Podcasts</h3>
        ${chipsHtml}
        ${statusHtml}
        ${bodyHtml}
      </div></ha-card>`;

      this.shadowRoot.querySelectorAll('.spk-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          const spk = chip.dataset.spk;
          if (spk === 'all') { this._selectedSpeakers = null; }
          else {
            if (!this._selectedSpeakers) this._selectedSpeakers = [];
            const idx = this._selectedSpeakers.indexOf(spk);
            if (idx > -1) { this._selectedSpeakers.splice(idx, 1); if (!this._selectedSpeakers.length) this._selectedSpeakers = null; }
            else { this._selectedSpeakers.push(spk); }
          }
          this._render();
        });
      });
      if (this._podcastView === 'episodes' && this._podcastShow) {
        this.shadowRoot.getElementById('pod-back')?.addEventListener('click', () => { this._podcastView = 'search'; this._podcastShow = null; this._render(); });
        this.shadowRoot.getElementById('pod-fav')?.addEventListener('click', () => this._toggleFavorite(this._podcastShow));
        this.shadowRoot.querySelectorAll('.ep-play').forEach(b => b.addEventListener('click', () => {
          const ep = this._podcastEpisodes[parseInt(b.dataset.i)];
          if (ep) this._playGuideId(ep.guide_id, ep.title, ep.image || this._podcastShow.image);
        }));
      } else {
        const favUrl = this.shadowRoot.getElementById('fav-url');
        this.shadowRoot.getElementById('fav-add')?.addEventListener('click', () => this._addFavoriteByUrl(favUrl.value));
        favUrl?.addEventListener('keydown', e => { if (e.key === 'Enter') this._addFavoriteByUrl(favUrl.value); });
        this.shadowRoot.querySelectorAll('.fav-eps').forEach(b => b.addEventListener('click', () => { const f = this._podcastFavorites[parseInt(b.dataset.i)]; if (f) this._openEpisodes(f); }));
        this.shadowRoot.querySelectorAll('.fav-play').forEach(b => b.addEventListener('click', () => { const f = this._podcastFavorites[parseInt(b.dataset.i)]; if (f) this._playGuideId(f.guide_id, f.name, f.image); }));
        this.shadowRoot.querySelectorAll('.fav-del').forEach(b => b.addEventListener('click', () => { const f = this._podcastFavorites[parseInt(b.dataset.i)]; if (f) this._toggleFavorite(f); }));
        const si = this.shadowRoot.getElementById('pod-search');
        const sb = this.shadowRoot.getElementById('pod-search-btn');
        sb?.addEventListener('click', () => this._podcastSearch(si.value));
        si?.addEventListener('keydown', e => { if (e.key === 'Enter') this._podcastSearch(si.value); });
        this.shadowRoot.querySelectorAll('.show-play').forEach(b => b.addEventListener('click', () => { const s = this._podcastShows[parseInt(b.dataset.i)]; if (s) this._playGuideId(s.guide_id, s.name, s.image); }));
        this.shadowRoot.querySelectorAll('.show-eps').forEach(b => b.addEventListener('click', () => { const s = this._podcastShows[parseInt(b.dataset.i)]; if (s) this._openEpisodes(s); }));
        this.shadowRoot.querySelectorAll('.show-fav').forEach(b => b.addEventListener('click', () => { const s = this._podcastShows[parseInt(b.dataset.i)]; if (s) this._toggleFavorite(s); }));
        this.shadowRoot.querySelectorAll('.st-fav').forEach(b => b.addEventListener('click', () => { const s = this._podcastStations[parseInt(b.dataset.i)]; if (s) this._toggleFavorite(s); }));
        this.shadowRoot.querySelectorAll('.st-play').forEach(b => b.addEventListener('click', () => { const s = this._podcastStations[parseInt(b.dataset.i)]; if (s && !s.unsupported) this._playGuideId(s.guide_id, s.name, s.image); }));
        this.shadowRoot.querySelectorAll('.pop-fav').forEach(b => b.addEventListener('click', () => { const s = this._tiPopular[parseInt(b.dataset.i)]; if (s) this._toggleFavorite(s); }));
        this.shadowRoot.querySelectorAll('.pop-play').forEach(b => b.addEventListener('click', () => { const s = this._tiPopular[parseInt(b.dataset.i)]; if (s) this._playGuideId(s.guide_id, s.name, s.image); }));
        this.shadowRoot.querySelectorAll('.pop-eps').forEach(b => b.addEventListener('click', () => { const s = this._tiPopular[parseInt(b.dataset.i)]; if (s) this._openEpisodes(s); }));
        const urlInput = this.shadowRoot.getElementById('podcast-url');
        const playBtn = this.shadowRoot.getElementById('podcast-play');
        const doPlay = () => { const u = urlInput.value.trim(); if (u) this._playPodcast(u); };
        playBtn?.addEventListener('click', doPlay);
        urlInput?.addEventListener('keydown', e => { if (e.key === 'Enter') doPlay(); });
      }
      return;
    }
    if (this._mode === "pushkin") {
      const speakerNames = this._getSpeakerNames();
      const allSelected = !this._selectedSpeakers || this._selectedSpeakers.length === 0;
      const chipsHtml = '<div class="spk-chips"><span class="spk-chip spk-chip-all ' + (allSelected?'active':'') + '" data-spk="all">All</span>' +
        speakerNames.map(s => '<span class="spk-chip ' + (!allSelected && this._selectedSpeakers.includes(s.id)?'active':'') + '" data-spk="' + s.id + '">' + s.name + '</span>').join('') + '</div>';
      const statusHtml = this._podcastStatus ? `<div class="podcast-status ${this._podcastStatus.type}">${this._podcastStatus.msg}</div>` : '';

      let bodyHtml;
      if (this._pkView === 'episodes' && this._pkShow) {
        const fav = this._pkIsFavorite(this._pkShow.slug);
        const eps = this._pkLoading
          ? '<div class="loading">Loading episodes...</div>'
          : this._pkEpisodes.length ? this._pkEpisodes.map((ep, i) => `
            <div class="result">
              <div class="result-art">${ep.image?`<img src="${this._esc(ep.image)}" alt=""/>`:'<div style="font-size:20px">&#x1F3A7;</div>'}</div>
              <div class="result-info">
                <div class="result-name">${this._esc(ep.title)}</div>
                <div class="result-sub">${this._esc((ep.date||'').replace(/\s*\d\d:\d\d:\d\d.*$/,''))}${this._fmtDuration(ep.duration_seconds)?' &middot; '+this._fmtDuration(ep.duration_seconds):''}</div>
              </div>
              <button class="play-btn pk-ep-play" data-i="${i}" ${this._podcastLoading?'disabled':''}>&#x25B6; Play</button>
            </div>`).join('') : '<div class="empty">No episodes found</div>';
        bodyHtml = `
          <div class="ep-header">
            <button class="back-btn" id="pk-back" title="Back to shows">&#x2190;</button>
            <div class="result-art">${this._pkShow.image?`<img src="${this._esc(this._pkShow.image)}" alt=""/>`:'&#x1F399;'}</div>
            <div class="result-info"><div class="result-name">${this._esc(this._pkShow.name)}</div><div class="result-sub">Recent episodes</div></div>
            <button class="fav-btn ${fav?'active':''}" id="pk-fav" title="${fav?'Remove favorite':'Save favorite'}">${fav?'&#x2665;':'&#x2661;'}</button>
          </div>
          <div class="results">${eps}</div>`;
      } else {
        const favRows = this._pkFavorites.map((f, i) => `
          <div class="result">
            <div class="result-art">${f.image?`<img src="${this._esc(f.image)}" alt=""/>`:'<div style="font-size:20px">&#x1F399;</div>'}</div>
            <div class="result-info"><div class="result-name">${this._esc(f.name)}</div><div class="result-sub">show</div></div>
            <div class="pandora-btns"><button class="play-btn pk-fav-play" data-i="${i}" ${this._podcastLoading?'disabled':''} title="Play latest episode">&#x25B6; Play</button><button class="play-btn pk-fav-eps" data-i="${i}">Episodes</button></div>
            <button class="fav-del pk-fav-del" data-i="${i}" title="Remove favorite">&#x2715;</button>
          </div>`).join('');
        bodyHtml = `
          <div class="pandora-acct-header">Pushkin Favorites</div>
          ${this._pkFavorites.length ? `<div class="results" style="max-height:230px;margin-bottom:10px">${favRows}</div>` : '<div class="empty" style="padding:6px 0 12px">No favorites yet - &#x2661; a show below</div>'}
          <div class="pandora-acct-header">Search Pushkin</div>
          <div class="search-row">
            <input class="search-input" id="pk-filter" type="text" placeholder="Search Pushkin shows (e.g. Revisionist History)" value="${this._esc(this._pkFilter)}"/>
            <button class="search-btn" id="pk-filter-btn">Search</button>
          </div>
          <div class="pandora-acct-header">Shows</div>
          <div class="results" id="pk-show-list">${this._pkShowRowsHtml()}</div>`;
      }

      this.shadowRoot.innerHTML = `<style>${this._styles()}</style><ha-card><div class="podcast-card">
        <h3>Pushkin-Podcasts</h3>
        ${chipsHtml}
        ${statusHtml}
        ${bodyHtml}
      </div></ha-card>`;

      this.shadowRoot.querySelectorAll('.spk-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          const spk = chip.dataset.spk;
          if (spk === 'all') { this._selectedSpeakers = null; }
          else {
            if (!this._selectedSpeakers) this._selectedSpeakers = [];
            const idx = this._selectedSpeakers.indexOf(spk);
            if (idx > -1) { this._selectedSpeakers.splice(idx, 1); if (!this._selectedSpeakers.length) this._selectedSpeakers = null; }
            else { this._selectedSpeakers.push(spk); }
          }
          this._render();
        });
      });
      if (this._pkView === 'episodes' && this._pkShow) {
        this.shadowRoot.getElementById('pk-back')?.addEventListener('click', () => { this._pkView = 'list'; this._pkShow = null; this._render(); });
        this.shadowRoot.getElementById('pk-fav')?.addEventListener('click', () => this._pkToggleFavorite(this._pkShow));
        this.shadowRoot.querySelectorAll('.pk-ep-play').forEach(b => b.addEventListener('click', () => {
          const ep = this._pkEpisodes[parseInt(b.dataset.i)];
          if (ep) this._playStreamUrl(ep.audio_url, `${this._pkShow.name}: ${ep.title}`, ep.image || this._pkShow.image);
        }));
      } else {
        const pf = this.shadowRoot.getElementById('pk-filter');
        // Keystrokes must never leak to HA's global hotkey handler (quick-bar
        // opens on bare letters), and the input must never be re-rendered
        // mid-typing or focus drops to <body> and letters become hotkeys.
        // So: swallow key events and patch only the list below, in place.
        pf?.addEventListener('keydown', e => e.stopPropagation());
        pf?.addEventListener('keyup', e => e.stopPropagation());
        pf?.addEventListener('input', () => { this._pkFilter = pf.value; this._pkRefreshShowList(); });
        this.shadowRoot.getElementById('pk-filter-btn')?.addEventListener('click', () => { this._pkFilter = pf ? pf.value : ''; this._pkRefreshShowList(); });
        this._pkBindShowRows();
        this.shadowRoot.querySelectorAll('.pk-fav-play').forEach(b => b.addEventListener('click', () => { const f = this._pkFavorites[parseInt(b.dataset.i)]; if (f) this._pkPlayLatest(f); }));
        this.shadowRoot.querySelectorAll('.pk-fav-eps').forEach(b => b.addEventListener('click', () => { const f = this._pkFavorites[parseInt(b.dataset.i)]; if (f) this._pkOpenEpisodes(f); }));
        this.shadowRoot.querySelectorAll('.pk-fav-del').forEach(b => b.addEventListener('click', () => { const f = this._pkFavorites[parseInt(b.dataset.i)]; if (f) this._pkToggleFavorite(f); }));
      }
      return;
    }
    if (this._mode === "iheart") {
      const speakerNames = this._getSpeakerNames();
      const allSelected = !this._selectedSpeakers || this._selectedSpeakers.length === 0;
      const chipsHtml = '<div class="spk-chips"><span class="spk-chip spk-chip-all ' + (allSelected?'active':'') + '" data-spk="all">All</span>' +
        speakerNames.map(s => '<span class="spk-chip ' + (!allSelected && this._selectedSpeakers.includes(s.id)?'active':'') + '" data-spk="' + s.id + '">' + s.name + '</span>').join('') + '</div>';
      const statusHtml = this._podcastStatus ? `<div class="podcast-status ${this._podcastStatus.type}">${this._podcastStatus.msg}</div>` : '';

      let bodyHtml;
      if (this._ihView === 'episodes' && this._ihShow) {
        const fav = this._ihIsFavorite(this._ihShow.guide_id);
        const eps = this._ihEpisodesLoading
          ? '<div class="loading">Loading episodes...</div>'
          : this._ihEpisodes.length ? this._ihEpisodes.map((ep, i) => `
            <div class="result">
              <div class="result-art">${ep.image?`<img src="${this._esc(ep.image)}" alt=""/>`:'<div style="font-size:20px">&#x1F3A7;</div>'}</div>
              <div class="result-info">
                <div class="result-name">${this._esc(ep.title)}</div>
                <div class="result-sub">${this._esc(ep.date || '')}${this._fmtDuration(ep.duration_seconds)?' &middot; '+this._fmtDuration(ep.duration_seconds):''}</div>
              </div>
              <button class="play-btn ih-ep-play" data-i="${i}" ${this._podcastLoading?'disabled':''}>&#x25B6; Play</button>
            </div>`).join('') : '<div class="empty">No episodes found</div>';
        bodyHtml = `
          <div class="ep-header">
            <button class="back-btn" id="ih-back" title="Back to search">&#x2190;</button>
            <div class="result-art">${this._ihShow.image?`<img src="${this._esc(this._ihShow.image)}" alt=""/>`:'&#x1F399;'}</div>
            <div class="result-info"><div class="result-name">${this._esc(this._ihShow.name)}</div><div class="result-sub">Recent episodes</div></div>
            <button class="fav-btn ${fav?'active':''}" id="ih-fav" title="${fav?'Remove favorite':'Save favorite'}">${fav?'&#x2665;':'&#x2661;'}</button>
          </div>
          <div class="results">${eps}</div>`;
      } else {
        const favRows = this._ihFavorites.map((f, i) => `
          <div class="result">
            <div class="result-art">${f.image?`<img src="${this._esc(f.image)}" alt=""/>`:'<div style="font-size:20px">&#x1F399;</div>'}</div>
            <div class="result-info"><div class="result-name">${this._esc(f.name)}</div><div class="result-sub">show</div></div>
            <div class="pandora-btns"><button class="play-btn ih-fav-play" data-i="${i}" ${this._podcastLoading?'disabled':''} title="Play latest episode">&#x25B6; Play</button><button class="play-btn ih-fav-eps" data-i="${i}">Episodes</button></div>
            <button class="fav-del ih-fav-del" data-i="${i}" title="Remove favorite">&#x2715;</button>
          </div>`).join('');
        let resultsHtml;
        if (this._ihSearching) resultsHtml = '<div class="loading">Searching iHeart...</div>';
        else if (this._ihShows.length) resultsHtml = this._ihShows.map((s, i) => `
          <div class="result">
            <div class="result-art">${s.image?`<img src="${this._esc(s.image)}" alt=""/>`:'<div style="font-size:20px">&#x1F399;</div>'}</div>
            <div class="result-info"><div class="result-name">${this._esc(s.name)}</div>${s.description?`<div class="result-sub">${this._esc(s.description)}</div>`:''}</div>
            <button class="fav-btn ${this._ihIsFavorite(s.guide_id)?'active':''} ih-show-fav" data-i="${i}" title="Favorite">${this._ihIsFavorite(s.guide_id)?'&#x2665;':'&#x2661;'}</button>
            <div class="pandora-btns"><button class="play-btn ih-show-play" data-i="${i}" ${this._podcastLoading?'disabled':''} title="Play latest episode">&#x25B6;</button><button class="play-btn ih-show-eps" data-i="${i}">Episodes</button></div>
          </div>`).join('');
        else if (this._ihQuery) resultsHtml = '<div class="empty">No results</div>';
        else resultsHtml = '<div class="empty">Search above to find iHeart shows</div>';
        bodyHtml = `
          <div class="pandora-acct-header">iHeart Favorites</div>
          ${this._ihFavorites.length ? `<div class="results" style="max-height:230px;margin-bottom:10px">${favRows}</div>` : '<div class="empty" style="padding:6px 0 12px">No favorites yet - &#x2661; a show below</div>'}
          <div class="pandora-acct-header">Search iHeart</div>
          <div class="search-row">
            <input class="search-input" id="ih-search" type="text" placeholder="Search iHeart podcasts (e.g. Behind the Bastards)" value="${this._esc(this._ihQuery)}"/>
            <button class="search-btn" id="ih-search-btn" ${this._ihSearching?'disabled':''}>${this._ihSearching?'...':'Search'}</button>
          </div>
          <div class="pandora-acct-header">Shows</div>
          <div class="results">${resultsHtml}</div>`;
      }

      this.shadowRoot.innerHTML = `<style>${this._styles()}</style><ha-card><div class="podcast-card">
        <h3>iHeart-Podcasts</h3>
        ${chipsHtml}
        ${statusHtml}
        ${bodyHtml}
      </div></ha-card>`;

      this.shadowRoot.querySelectorAll('.spk-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          const spk = chip.dataset.spk;
          if (spk === 'all') { this._selectedSpeakers = null; }
          else {
            if (!this._selectedSpeakers) this._selectedSpeakers = [];
            const idx = this._selectedSpeakers.indexOf(spk);
            if (idx > -1) { this._selectedSpeakers.splice(idx, 1); if (!this._selectedSpeakers.length) this._selectedSpeakers = null; }
            else { this._selectedSpeakers.push(spk); }
          }
          this._render();
        });
      });
      if (this._ihView === 'episodes' && this._ihShow) {
        this.shadowRoot.getElementById('ih-back')?.addEventListener('click', () => { this._ihView = 'search'; this._ihShow = null; this._render(); });
        this.shadowRoot.getElementById('ih-fav')?.addEventListener('click', () => this._ihToggleFavorite(this._ihShow));
        this.shadowRoot.querySelectorAll('.ih-ep-play').forEach(b => b.addEventListener('click', () => {
          const ep = this._ihEpisodes[parseInt(b.dataset.i)];
          if (ep) this._ihPlayEpisode(ep, this._ihShow.name, this._ihShow.image);
        }));
      } else {
        const si = this.shadowRoot.getElementById('ih-search');
        // Search fires on Enter / the Search button ONLY -- never per
        // keystroke: a full re-render would destroy the focused input and
        // bare letters would fall through to HA's global hotkeys (the
        // quick-bar bug; see the pushkin filter note above). Key events are
        // swallowed so they never reach HA's handler either.
        si?.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') this._ihSearch(si.value); });
        si?.addEventListener('keyup', e => e.stopPropagation());
        this.shadowRoot.getElementById('ih-search-btn')?.addEventListener('click', () => { if (si) this._ihSearch(si.value); });
        this.shadowRoot.querySelectorAll('.ih-fav-play').forEach(b => b.addEventListener('click', () => { const f = this._ihFavorites[parseInt(b.dataset.i)]; if (f) this._ihPlayLatest(f); }));
        this.shadowRoot.querySelectorAll('.ih-fav-eps').forEach(b => b.addEventListener('click', () => { const f = this._ihFavorites[parseInt(b.dataset.i)]; if (f) this._ihOpenEpisodes(f); }));
        this.shadowRoot.querySelectorAll('.ih-fav-del').forEach(b => b.addEventListener('click', () => { const f = this._ihFavorites[parseInt(b.dataset.i)]; if (f) this._ihToggleFavorite(f); }));
        this.shadowRoot.querySelectorAll('.ih-show-fav').forEach(b => b.addEventListener('click', () => { const s = this._ihShows[parseInt(b.dataset.i)]; if (s) this._ihToggleFavorite(s); }));
        this.shadowRoot.querySelectorAll('.ih-show-play').forEach(b => b.addEventListener('click', () => { const s = this._ihShows[parseInt(b.dataset.i)]; if (s) this._ihPlayLatest(s); }));
        this.shadowRoot.querySelectorAll('.ih-show-eps').forEach(b => b.addEventListener('click', () => { const s = this._ihShows[parseInt(b.dataset.i)]; if (s) this._ihOpenEpisodes(s); }));
      }
      return;
    }
    if (this._mode === "spotify") {
      const speakerNames = this._getSpeakerNames();
      const allSelected = !this._selectedSpeakers || this._selectedSpeakers.length === 0;
      const chipsHtml = '<div class="spk-chips"><span class="spk-chip spk-chip-all ' + (allSelected?'active':'') + '" data-spk="all">All</span>' +
        speakerNames.map(s => '<span class="spk-chip ' + (!allSelected && this._selectedSpeakers.includes(s.id)?'active':'') + '" data-spk="' + s.id + '">' + s.name + '</span>').join('') + '</div>';
      const statusHtml = this._podcastStatus ? `<div class="podcast-status ${this._podcastStatus.type}">${this._podcastStatus.msg}</div>` : '';
      const st = this._spStatus;

      let bodyHtml;
      if (this._spView === 'episodes' && this._spShow) {
        const fav = this._spIsFavorite(this._spShow.uri);
        const eps = this._spLoading
          ? '<div class="loading">Loading episodes...</div>'
          : this._spEpisodes.length ? this._spEpisodes.map((ep, i) => {
            const inList = this._spInPlaylist(ep.uri);
            return `
            <div class="result">
              <div class="result-art">${ep.image?`<img src="${this._esc(ep.image)}" alt=""/>`:'<div style="font-size:20px">&#x1F3A7;</div>'}</div>
              <div class="result-info">
                <div class="result-name">${this._esc(ep.title)}</div>
                <div class="result-sub">${this._esc(ep.date)}${this._fmtDuration(ep.duration_seconds)?' &middot; '+this._fmtDuration(ep.duration_seconds):''}</div>
              </div>
              <button class="np-btn sp-add ${inList?'added':''}" data-uri="${this._esc(ep.uri)}" data-i="${i}" title="${inList?'In playlist (tap to remove)':'Add to playlist'}">${inList?'&#x2713;':'&#x2b;'}</button>
              <button class="play-btn sp-ep-play" data-i="${i}" ${this._podcastLoading?'disabled':''}>&#x25B6; Play</button>
            </div>`;}).join('') : '<div class="empty">No episodes found</div>';
        bodyHtml = `
          <div class="ep-header">
            <button class="back-btn" id="sp-back" title="Back to shows">&#x2190;</button>
            <div class="result-art">${this._spShow.image?`<img src="${this._esc(this._spShow.image)}" alt=""/>`:'&#x1F399;'}</div>
            <div class="result-info"><div class="result-name">${this._esc(this._spShow.name)}</div><div class="result-sub">Newest episodes &middot; + adds to your playlist</div></div>
            <button class="fav-btn ${fav?'active':''}" id="sp-fav" title="${fav?'Remove favorite':'Save favorite'}">${fav?'&#x2665;':'&#x2661;'}</button>
          </div>
          <div class="results">${eps}</div>`;
      } else {
        const favRows = this._spFavorites.map((f, i) => `
          <div class="result">
            <div class="result-art">${f.image?`<img src="${this._esc(f.image)}" alt=""/>`:'<div style="font-size:20px">&#x1F399;</div>'}</div>
            <div class="result-info"><div class="result-name">${this._esc(f.name)}</div><div class="result-sub">show</div></div>
            <div class="pandora-btns"><button class="play-btn sp-fav-play" data-i="${i}" ${this._podcastLoading?'disabled':''} title="Play show">&#x25B6; Play</button><button class="play-btn sp-fav-eps" data-i="${i}">Episodes</button></div>
            <button class="fav-del sp-fav-del" data-i="${i}" title="Remove favorite">&#x2715;</button>
          </div>`).join('');
        // Playback goes through the speaker's NATIVE Spotify client (DRM) -
        // it only works once a Spotify account is linked on the speakers.
        const accountWarn = st && !st.speaker_account
          ? '<div class="warn-banner">No Spotify account is linked yet, so playback will fail. Link a Spotify Premium account via the SoundCork webui first - search and favorites work regardless.</div>'
          : '';
        const favsHtml = `
          <div class="pandora-acct-header">Spotify Favorites</div>
          ${this._spFavorites.length ? `<div class="results" style="max-height:230px;margin-bottom:10px">${favRows}</div>` : '<div class="empty" style="padding:6px 0 12px">No favorites yet - &#x2661; a search result below</div>'}`;
        let searchHtml;
        if (st && !st.configured) {
          searchHtml = `
          <div class="pandora-acct-header">Search Spotify</div>
          <div class="warn-banner">Spotify search is not set up on SoundCork yet. Create a free app at developer.spotify.com/dashboard, then set the <b>SPOTIFY_CLIENT_ID</b> and <b>SPOTIFY_CLIENT_SECRET</b> environment variables on the soundcork container and restart it. Existing favorites above keep working.</div>`;
        } else {
          searchHtml = `
          <div class="pandora-acct-header">Search Spotify</div>
          <div class="search-row">
            <input class="search-input" id="sp-search" type="text" placeholder="Search podcast shows (e.g. Heavyweight)" value="${this._esc(this._spQuery)}"/>
            <button class="search-btn" id="sp-search-btn" ${this._spSearching?'disabled':''}>${this._spSearching?'...':'Search'}</button>
          </div>`;
        }
        let resultsHtml = '';
        if (this._spSearching) resultsHtml = '<div class="loading">Searching Spotify...</div>';
        else if (this._spShows.length) resultsHtml = this._spShows.map((s, i) => `
              <div class="result">
                <div class="result-art">${s.image?`<img src="${this._esc(s.image)}" alt=""/>`:'<div style="font-size:20px">&#x1F399;</div>'}</div>
                <div class="result-info"><div class="result-name">${this._esc(s.name)}</div>${s.publisher?`<div class="result-sub">${this._esc(s.publisher)}</div>`:''}</div>
                <button class="fav-btn ${this._spIsFavorite(s.uri)?'active':''} sp-show-fav" data-i="${i}" title="Favorite">${this._spIsFavorite(s.uri)?'&#x2665;':'&#x2661;'}</button>
                <div class="pandora-btns"><button class="play-btn sp-show-play" data-i="${i}" ${this._podcastLoading?'disabled':''} title="Play show">&#x25B6;</button><button class="play-btn sp-show-eps" data-i="${i}">Episodes</button></div>
              </div>`).join('');
        else if (this._spQuery && !this._spSearching) resultsHtml = '<div class="empty">No results</div>';
        bodyHtml = `${accountWarn}${favsHtml}${searchHtml}<div class="results">${resultsHtml}</div>`;
      }

      this.shadowRoot.innerHTML = `<style>${this._styles()}</style><ha-card><div class="podcast-card">
        <h3>Spotify-Podcasts</h3>
        ${chipsHtml}
        ${statusHtml}
        <div id="sp-now"></div>
        ${bodyHtml}
      </div></ha-card>`;

      this._spUpdateNowBar();
      this._spStartPolling();

      this.shadowRoot.querySelectorAll('.spk-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          const spk = chip.dataset.spk;
          if (spk === 'all') { this._selectedSpeakers = null; }
          else {
            if (!this._selectedSpeakers) this._selectedSpeakers = [];
            const idx = this._selectedSpeakers.indexOf(spk);
            if (idx > -1) { this._selectedSpeakers.splice(idx, 1); if (!this._selectedSpeakers.length) this._selectedSpeakers = null; }
            else { this._selectedSpeakers.push(spk); }
          }
          this._render();
        });
      });
      if (this._spView === 'episodes' && this._spShow) {
        this.shadowRoot.getElementById('sp-back')?.addEventListener('click', () => { this._spView = 'list'; this._spShow = null; this._render(); });
        this.shadowRoot.getElementById('sp-fav')?.addEventListener('click', () => this._spToggleFavorite(this._spShow));
        this.shadowRoot.querySelectorAll('.sp-ep-play').forEach(b => b.addEventListener('click', () => {
          const ep = this._spEpisodes[parseInt(b.dataset.i)];
          if (ep) this._spPlay(ep.uri, `${this._spShow.name}: ${ep.title}`, ep.image || this._spShow.image);
        }));
        // + adds to (or removes from) the persistent playlist in place
        this.shadowRoot.querySelectorAll('.sp-add').forEach(b => b.addEventListener('click', () => {
          const ep = this._spEpisodes[parseInt(b.dataset.i)];
          if (!ep) return;
          if (this._spInPlaylist(ep.uri)) this._spRemoveFromPlaylist(ep.uri);
          else this._spAddToPlaylist(ep);
        }));
      } else {
        const si = this.shadowRoot.getElementById('sp-search');
        // Search fires on Enter/button ONLY (commit 1b1c611 lesson: a
        // per-keystroke _render() drops input focus and bare letters become
        // HA quick-bar hotkeys), and key events must not leak to HA.
        si?.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') this._spSearch(si.value); });
        si?.addEventListener('keyup', e => e.stopPropagation());
        this.shadowRoot.getElementById('sp-search-btn')?.addEventListener('click', () => { if (si) this._spSearch(si.value); });
        this.shadowRoot.querySelectorAll('.sp-fav-play').forEach(b => b.addEventListener('click', () => { const f = this._spFavorites[parseInt(b.dataset.i)]; if (f) this._spPlay(f.guide_id, f.name, f.image); }));
        this.shadowRoot.querySelectorAll('.sp-fav-eps').forEach(b => b.addEventListener('click', () => { const f = this._spFavorites[parseInt(b.dataset.i)]; if (f) this._spOpenEpisodes(f); }));
        this.shadowRoot.querySelectorAll('.sp-fav-del').forEach(b => b.addEventListener('click', () => { const f = this._spFavorites[parseInt(b.dataset.i)]; if (f) this._spToggleFavorite(f); }));
        this.shadowRoot.querySelectorAll('.sp-show-fav').forEach(b => b.addEventListener('click', () => { const s = this._spShows[parseInt(b.dataset.i)]; if (s) this._spToggleFavorite(s); }));
        this.shadowRoot.querySelectorAll('.sp-show-play').forEach(b => b.addEventListener('click', () => { const s = this._spShows[parseInt(b.dataset.i)]; if (s) this._spPlay(s.uri, s.name, s.image); }));
        this.shadowRoot.querySelectorAll('.sp-show-eps').forEach(b => b.addEventListener('click', () => { const s = this._spShows[parseInt(b.dataset.i)]; if (s) this._spOpenEpisodes(s); }));
      }
      return;
    }
    if (this._mode === "radio") {
      const speakerNames = this._getSpeakerNames();
      const allSelected = !this._selectedSpeakers || this._selectedSpeakers.length === 0;
      const chipsHtml = this._currentPresets.length
        ? this._currentPresets.map(p => `<div class="chip ${this._selectedSlot===p.id?'active':''}" data-slot="${p.id}">${p.art?`<img src="${p.art}" alt=""/>`:''}  <span>${p.id}. ${p.name}</span></div>`).join('')
        : Array.from({length:6},(_,i)=>`<div class="chip ${this._selectedSlot===i+1?'active':''}" data-slot="${i+1}"><span>${i+1}. --</span></div>`).join('');
      const spkChipsHtml = '<div class="spk-chips"><span class="spk-chip spk-chip-all ' + (allSelected?'active':'') + '" data-spk="all">All</span>' +
        speakerNames.map(s => '<span class="spk-chip ' + (!allSelected && this._selectedSpeakers.includes(s.id)?'active':'') + '" data-spk="' + s.id + '">' + s.name + '</span>').join('') + '</div>';
      this.shadowRoot.innerHTML = `<style>${this._styles()}</style><ha-card><div class="card">
        <h3>Direct Stream Preset</h3>
        <div class="warn-banner">Recommended over TuneIn search: Bose's TuneIn backend was shut down, so TuneIn-sourced presets can silently stop working later. Paste a direct audio stream URL here instead - it plays straight from the source, no Bose lookup involved.</div>
        <div class="chips">${chipsHtml}</div>
        ${spkChipsHtml}
        ${this._message?`<div class="message">${this._message}</div>`:''}
        <div class="search-row"><input class="search-input" id="radio-name" type="text" placeholder="Station name (e.g. WUWM)"/></div>
        <div class="search-row"><input class="search-input" id="radio-url" type="text" placeholder="Direct stream URL (e.g. https://.../stream.mp3)" spellcheck="false" autocomplete="off"/></div>
        <div class="search-row"><input class="search-input" id="radio-art" type="text" placeholder="Artwork URL (optional)" spellcheck="false" autocomplete="off"/></div>
        <button class="search-btn" id="radio-save" ${this._saving?'disabled':''}>${this._saving?'Saving...':`Save to preset ${this._selectedSlot}`}</button>
      </div></ha-card>`;
      this.shadowRoot.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => { this._selectedSlot=parseInt(c.dataset.slot); this._render(); }));
      this.shadowRoot.querySelectorAll('.spk-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          const spk = chip.dataset.spk;
          if (spk === 'all') { this._selectedSpeakers = null; }
          else {
            if (!this._selectedSpeakers) this._selectedSpeakers = [];
            const idx = this._selectedSpeakers.indexOf(spk);
            if (idx > -1) { this._selectedSpeakers.splice(idx, 1); if (!this._selectedSpeakers.length) this._selectedSpeakers = null; }
            else { this._selectedSpeakers.push(spk); }
          }
          this._render();
        });
      });
      const nameInput = this.shadowRoot.getElementById('radio-name');
      const urlInput2 = this.shadowRoot.getElementById('radio-url');
      const artInput = this.shadowRoot.getElementById('radio-art');
      this.shadowRoot.getElementById('radio-save')?.addEventListener('click', () => {
        this._saveRadioPreset(nameInput.value.trim(), urlInput2.value.trim(), artInput.value.trim());
      });
      return;
    }
    if (this._mode === "pandora") {
      // Group stations by account
      const accounts = {};
      this._pandoraStations.forEach(s => {
        if (!accounts[s.sourceAccount]) accounts[s.sourceAccount] = [];
        accounts[s.sourceAccount].push(s);
      });
      const accountKeys = Object.keys(accounts);

      // Preset slot chips
      const chipsHtml = this._currentPresets.length
        ? this._currentPresets.map(p => `<div class="chip ${this._selectedSlot===p.id?'active':''}" data-slot="${p.id}">${p.art?`<img src="${p.art}" alt=""/>`:''}  <span>${p.id}. ${p.name}</span></div>`).join('')
        : Array.from({length:6},(_,i)=>`<div class="chip ${this._selectedSlot===i+1?'active':''}" data-slot="${i+1}"><span>${i+1}. --</span></div>`).join('');

      // Station list grouped by account
      let stationHtml = '';
      if (!this._pandoraStations.length) {
        stationHtml = '<div class="empty">No Pandora stations found.<br>Play a Pandora station on any speaker first.</div>';
      } else {
        accountKeys.forEach(acct => {
          stationHtml += `<div class="pandora-acct-header">${acct}</div>`;
          accounts[acct].forEach(s => {
            stationHtml += `<div class="pandora-item">
              <div class="pandora-art">${s.art?`<img src="${s.art}" alt=""/>`:'?'}</div>
              <div class="pandora-info"><div class="pandora-name">${s.name}</div></div>
              <div class="pandora-btns">
                <button class="play-btn" data-loc="${s.location}" data-acct="${this._esc(s.sourceAccount)}" data-name="${this._esc(s.name)}" data-art="${this._esc(s.art)}">Play</button>
                <button class="save-btn" data-loc="${s.location}" data-acct="${this._esc(s.sourceAccount)}" data-name="${this._esc(s.name)}" data-art="${this._esc(s.art)}">${this._saving?'...':'Save'}</button>
              </div>
            </div>`;
          });
        });
      }

      this.shadowRoot.innerHTML = `<style>${this._styles()}</style><ha-card><div class="card">
        <div class="pandora-header">
          <h3 style="margin:0">Pandora</h3>
          <button class="refresh-btn ${this._pandoraRefreshing ? 'spinning' : ''}" id="pandora-refresh" title="Refresh stations">&#x21BB;</button>
        </div>
        <div style="font-size:11px;color:var(--secondary-text-color);margin-bottom:10px;">Select a preset slot to save to, then click Save on any station.</div>
        <div class="chips">${chipsHtml}</div>
        ${this._message?`<div class="message">${this._message}</div>`:''}
        <div class="pandora-list">${stationHtml}</div>
      </div></ha-card>`;

      this.shadowRoot.getElementById('pandora-refresh')?.addEventListener('click', () => { if (!this._pandoraRefreshing) this._loadPandora(); });
      this.shadowRoot.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => { this._selectedSlot=parseInt(c.dataset.slot); this._render(); }));
      this.shadowRoot.querySelectorAll('.play-btn').forEach(b => b.addEventListener('click', () => this._playPandora({ location:b.dataset.loc, sourceAccount:b.dataset.acct, name:b.dataset.name, art:b.dataset.art })));
      this.shadowRoot.querySelectorAll('.save-btn').forEach(b => b.addEventListener('click', () => this._savePandoraPreset({ location:b.dataset.loc, sourceAccount:b.dataset.acct, name:b.dataset.name, art:b.dataset.art })));
      return;
    }
    if (this._mode === "speaker") {
      this.shadowRoot.innerHTML = `<style>${this._styles()}</style><ha-card>${this._renderSpeaker()}</ha-card>`;
      const adjustVolume = async (delta) => {
        // Prefer a playing speaker for accurate volume reading
        const playingId = this._speakers.find(id => {
          const s = this._hass && this._hass.states[id];
          return s && s.state === "playing";
        }) || this._speakers.find(id => {
          const s = this._hass && this._hass.states[id];
          return s && s.state !== "unavailable" && (s.attributes.volume_level || 0) > 0;
        });
        const state = playingId && this._hass && this._hass.states[playingId];
        const currentVol = state ? Math.round((state.attributes.volume_level || 0) * 100) : 0;
        const newVol = Math.max(0, Math.min(100, currentVol + delta));
        // Update bar immediately for instant feedback
        const bar = this.shadowRoot.getElementById("vol-bar");
        const pct = this.shadowRoot.getElementById("vol-pct");
        if (bar) bar.style.width = newVol + "%";
        if (pct) pct.textContent = newVol + "%";
        await this._setVolumeAll(newVol);
      };
      this.shadowRoot.getElementById("vol-up")?.addEventListener("click", () => adjustVolume(5));
      this.shadowRoot.getElementById("vol-down")?.addEventListener("click", () => adjustVolume(-5));
      this.shadowRoot.getElementById("spk-pwr")?.addEventListener("click", () => {
        const np = this._data && this._data.now_playing;
        const isOff = !np || !np.source || np.source === "STANDBY";
        const ip = this._getSpeakerIps()[0];
        if (ip) fetch(`${this._baseUrl}/api/v1/speakers/${ip}/power-${isOff ? "on" : "off"}`, {method:"POST"});
      });
      return;
    }
    const p = this._mode === "player";
    const presets = this._currentPresets;
    let body = "";
    if (p) {
      const grid = presets.map(pr => `
        <button class="preset-btn ${this._playing===pr.id?"playing":""}" data-id="${pr.id}">
          ${pr.art ? `<img src="${pr.art}" alt=""/>` : ""}
          <div class="overlay"></div>
          <span class="slot-badge">${pr.id}</span>
          <span class="label">${pr.name}</span>
          ${this._playing===pr.id ? `<div class="spin">&#x25B6;</div>` : ""}
        </button>`).join("");
            const speakerNames = this._getSpeakerNames();
      const allSelected = !this._selectedSpeakers || this._selectedSpeakers.length === 0;
      const chipsHtml = '<div class="spk-chips"><span class="spk-chip spk-chip-all ' + (allSelected ? 'active' : '') + '" data-spk="all">All</span>' + speakerNames.map(s => '<span class="spk-chip ' + (!allSelected && this._selectedSpeakers.includes(s.id) ? 'active' : '') + '" data-spk="' + s.id + '">' + s.name + '</span>').join('') + '</div>';
      const playingSpeaker = this._speakers.find(id => { const s = this._hass && this._hass.states[id]; return s && s.state === 'playing'; })
        || this._speakers.find(id => { const s = this._hass && this._hass.states[id]; return s && s.state !== 'unavailable' && (s.attributes.volume_level || 0) > 0; });
      const firstState = playingSpeaker && this._hass && this._hass.states[playingSpeaker];
      const volPct = firstState ? Math.round((firstState.attributes.volume_level || 0) * 100) : 0;
      body = `<div class="card"><h3>Presets</h3>${chipsHtml}<div class="preset-grid">${grid}</div><div class="vol-bar-row"><div class="vol-bar-track"><div class="vol-bar-fill" id="vol-bar" style="width:${volPct}%"></div></div><span class="vol-bar-pct" id="vol-pct">${volPct}%</span></div><div class="vol-row"><span class="vol-label">&#x1F50A;</span><button class="vol-btn" id="vol-down">&#x2212;</button><button class="vol-btn" id="vol-up">&#x2B;</button></div><button class="off-btn" id="off-btn">Turn Off All Speakers</button></div>`;
    } else {
      const chips = presets.length ? presets.map(pr => `<div class="chip ${this._selectedSlot===pr.id?"active":""}" data-slot="${pr.id}">${pr.art?`<img src="${pr.art}" alt=""/>`:""}  <span>${pr.id}. ${pr.name}</span></div>`).join("") : Array.from({length:6},(_,i)=>`<div class="chip ${this._selectedSlot===i+1?"active":""}" data-slot="${i+1}"><span>${i+1}. ?</span></div>`).join("");
      const results = this._loading ? `<div class="loading">Searching TuneIn...</div>` : this._searchResults.length ? this._searchResults.map(r=>`
        <div class="result ${r.unsupported?"unsupported":""}">
          <div class="result-art">${r.image?`<img src="${r.image}" alt=""/>`:`<div style="font-size:20px">&#x1F4FB;</div>`}</div>
          <div class="result-info">
            <div class="result-name">${r.name}${r.unsupported?` <span class='badge'>not supported</span>`:""}${r.is_podcast?` <span class='badge' style='background:rgba(0,150,100,0.3);color:#00c890'>podcast</span>`:""}</div>
            ${r.subtext?`<div class="result-sub">${r.subtext}</div>`:""}
            ${r.bitrate?`<div class="result-sub">${r.bitrate} kbps</div>`:""}
          </div>
          ${!r.unsupported?`<button class="save-btn" data-guide="${r.guide_id}" data-name="${this._esc(r.name)}" data-image="${this._esc(r.image)}">${this._saving?"...":"Save"}</button>`:""}
        </div>`).join("") : `<div class="empty">Search for a radio station to replace preset ${this._selectedSlot}</div>`;
      const speakerNamesEd = this._getSpeakerNames();
      const allSelectedEd = !this._selectedSpeakers || this._selectedSpeakers.length === 0;
      const spkChipsHtmlEd = '<div class="spk-chips"><span class="spk-chip spk-chip-all ' + (allSelectedEd?'active':'') + '" data-spk="all">All</span>' + speakerNamesEd.map(s => '<span class="spk-chip ' + (!allSelectedEd && this._selectedSpeakers.includes(s.id)?'active':'') + '" data-spk="' + s.id + '">' + s.name + '</span>').join('') + '</div>';
      body = `<div class="card"><h3>TuneIn Preset Editor</h3><div class="warn-banner">Bose's TuneIn backend was shut down - a search result may still fail to play even if not marked "not supported". For anything important, use the Direct Stream card instead.</div>${spkChipsHtmlEd}<div class="chips">${chips}</div><div class="search-row"><input class="search-input" id="si" type="text" placeholder="Search TuneIn (e.g. WUWM, jazz, NPR)"/><button class="search-btn" id="sb" ${this._loading?"disabled":""}>${this._loading?"...":"Search"}</button></div>${this._message?`<div class="message">${this._message}</div>`:""}<div class="results">${results}</div></div>`;
    }
    this.shadowRoot.innerHTML = `<style>${this._styles()}</style><ha-card>${body}</ha-card>`;
    if (p) {
      this.shadowRoot.querySelectorAll(".preset-btn").forEach(b => b.addEventListener("click", () => { const pr = this._currentPresets.find(x=>x.id===parseInt(b.dataset.id)); if(pr) this._playPreset(pr); }));
      this.shadowRoot.getElementById("off-btn")?.addEventListener("click", () => this._turnOffAll());
      const adjustVolumeAll = async (delta) => {
        const playingId = this._speakers.find(id => { const s = this._hass && this._hass.states[id]; return s && s.state === "playing"; })
          || this._speakers.find(id => { const s = this._hass && this._hass.states[id]; return s && s.state !== "unavailable" && (s.attributes.volume_level || 0) > 0; });
        const state = playingId && this._hass && this._hass.states[playingId];
        const currentVol = state ? Math.round((state.attributes.volume_level || 0) * 100) : 0;
        const newVol = Math.max(0, Math.min(100, currentVol + delta));
        const bar = this.shadowRoot.getElementById("vol-bar");
        const pct = this.shadowRoot.getElementById("vol-pct");
        if (bar) bar.style.width = newVol + "%";
        if (pct) pct.textContent = newVol + "%";
        await this._setVolumeAll(newVol);
      };
      this.shadowRoot.getElementById("vol-down")?.addEventListener("click", () => adjustVolumeAll(-5));
      this.shadowRoot.getElementById("vol-up")?.addEventListener("click", () => adjustVolumeAll(5));
      this.shadowRoot.querySelectorAll(".spk-chip").forEach(chip => {
        chip.addEventListener("click", () => {
          const spk = chip.dataset.spk;
          if (spk === "all") { this._selectedSpeakers = null; }
          else {
            if (!this._selectedSpeakers) this._selectedSpeakers = [];
            const idx = this._selectedSpeakers.indexOf(spk);
            if (idx > -1) { this._selectedSpeakers.splice(idx, 1); if (this._selectedSpeakers.length === 0) this._selectedSpeakers = null; }
            else { this._selectedSpeakers.push(spk); }
          }
          this._render();
        });
      });
      
      const vs = this.shadowRoot.getElementById("vol-slider");
      const vv = this.shadowRoot.getElementById("vol-val");
      vs?.addEventListener("input", () => { vv.textContent = vs.value + "%"; });
      vs?.addEventListener("change", () => this._setVolumeAll(parseInt(vs.value)));
    } else {
      this.shadowRoot.querySelectorAll(".chip").forEach(c => c.addEventListener("click", () => { this._selectedSlot=parseInt(c.dataset.slot); this._render(); }));
      this.shadowRoot.querySelectorAll(".spk-chip").forEach(chip => {
        chip.addEventListener("click", () => {
          const spk = chip.dataset.spk;
          if (spk === "all") { this._selectedSpeakers = null; }
          else {
            if (!this._selectedSpeakers) this._selectedSpeakers = [];
            const idx = this._selectedSpeakers.indexOf(spk);
            if (idx > -1) { this._selectedSpeakers.splice(idx, 1); if (this._selectedSpeakers.length === 0) this._selectedSpeakers = null; }
            else { this._selectedSpeakers.push(spk); }
          }
          this._render();
        });
      });
      const si = this.shadowRoot.getElementById("si"), sb = this.shadowRoot.getElementById("sb");
      sb?.addEventListener("click", () => this._search(si.value));
      si?.addEventListener("keydown", e => { if(e.key==="Enter") this._search(si.value); });
      this.shadowRoot.querySelectorAll(".save-btn").forEach(b => b.addEventListener("click", () => this._savePreset({ guide_id:b.dataset.guide, name:b.dataset.name, image:b.dataset.image })));
    }
  }

  getCardSize() { return this._mode==="player" ? 5 : 4; }
  static getStubConfig() { return { soundcork_url:"http://192.168.1.229:8000", mode:"player", speakers:[] }; }
}

customElements.define("soundcork-preset-editor", SoundcorkPresetEditor);
window.customCards = window.customCards || [];
window.customCards.push({ type:"soundcork-preset-editor", name:"SoundCork Card", description:"Dynamic preset player and TuneIn editor for SoundCork" });
