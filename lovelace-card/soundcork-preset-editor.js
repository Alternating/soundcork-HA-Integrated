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

  async _playWithZone(xml) {
    const targets = this._getTargetSpeakers();
    if (!targets.length) return;
    // Filter to only reachable speakers before building zone
    const reachable = (await Promise.all(targets.map(async t => ({ ...t, up: await this._reachable(t.ip) })))).filter(t => t.up);
    if (!reachable.length) { console.warn("SoundCork: no reachable speakers"); return; }
    if (reachable.length === 1) {
      await fetch(`${this._baseUrl}/api/v1/speakers/${reachable[0].ip}/select`, {method:"POST",headers:{"Content-Type":"application/xml"},body:xml}).catch(()=>{});
    } else {
      const master = reachable[0], slaves = reachable.slice(1);
      await fetch(`${this._baseUrl}/api/v1/zone/set`, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ master_ip: master.ip, master_device_id: master.device_id, slaves: slaves })
      }).catch(()=>{});
      await new Promise(r => setTimeout(r, 300));
      await fetch(`${this._baseUrl}/api/v1/speakers/${master.ip}/select`, {method:"POST",headers:{"Content-Type":"application/xml"},body:xml}).catch(()=>{});
    }
  }

  async _playPreset(preset) {
    if (this._playing) return;
    this._playing = preset.id;
    this._render();
    const xml = `<ContentItem source="${preset.source}" type="${preset.type}" location="${preset.location}" sourceAccount="${preset.sourceAccount||""}" isPresetable="true"></ContentItem>`;
    await this._playWithZone(xml);
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

  _getTargetIps() {
    if (this._selectedSpeakers && this._selectedSpeakers.length > 0) {
      return this._selectedSpeakers.map(id => this._hass && this._hass.states[id] && this._hass.states[id].attributes.ip_address).filter(Boolean);
    }
    return this._getSpeakerIps();
  }

  _getSpeakerNames() {
    return this._speakers.map(id => {
      const state = this._hass && this._hass.states[id];
      return { id, name: state ? (state.attributes.friendly_name || id.split(".")[1]) : id.split(".")[1] };
    });
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
    try {
      const r = await fetch(`${this._baseUrl}/api/v1/pandora/stations`);
      const data = await r.json();
      this._pandoraStations = data.stations || [];
      this._render();
    } catch(e) { console.warn('SoundCork: loadPandora failed', e); }
  }

  async _playPandora(station) {
    const xml = `<ContentItem source="PANDORA" location="${station.location}" sourceAccount="${station.sourceAccount}" isPresetable="true"></ContentItem>`;
    await this._playWithZone(xml);
  }

  async _savePandoraPreset(station) {
    if (this._saving) return;
    this._saving = true; this._message = null; this._render();
    const xml = `<preset id="${this._selectedSlot}"><ContentItem source="PANDORA" location="${station.location}" sourceAccount="${station.sourceAccount}" isPresetable="true"><itemName>${this._esc(station.name)}</itemName><containerArt>${this._esc(station.art)}</containerArt></ContentItem></preset>`;
    const ips = this._getSpeakerIps();
    let ok = 0;
    for (const ip of ips) {
      try { const r = await fetch(`${this._baseUrl}/api/v1/speakers/${ip}/store-preset`, { method:'POST', headers:{'Content-Type':'application/xml'}, body:xml }); if(r.status<400) ok++; } catch(_) {}
    }
    this._message = ok===ips.length ? `Preset ${this._selectedSlot} saved: ${station.name}` : `Saved to ${ok}/${ips.length} speakers`;
    this._saving = false;
    await this._loadPresets();
    this._render();
    setTimeout(() => { this._message=null; this._render(); }, 4000);
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
    this._saving = true; this._message = null; this._render();
    let artUrl = station.image || "";
    try {
      const dd = await (await fetch(`${this._baseUrl}/api/v1/tunein/describe?id=${station.guide_id}`)).json();
      if (dd.body?.[0]?.logo) artUrl = dd.body[0].logo;
    } catch(_) {}
    const isPodcast = station.guide_id && station.guide_id.startsWith("p");
    const location = isPodcast ? `/v1/playback/show/${station.guide_id}` : `/v1/playback/station/${station.guide_id}`;
    const xml = `<preset id="${this._selectedSlot}"><ContentItem source="TUNEIN" type="stationurl" location="${location}" isPresetable="true"><itemName>${this._esc(station.name)}</itemName><containerArt>${this._esc(artUrl)}</containerArt></ContentItem></preset>`;
    const ips = this._getTargetIps();
    let ok = 0;
    for (const ip of ips) {
      try { const r = await fetch(`${this._baseUrl}/api/v1/speakers/${ip}/store-preset`, { method:"POST", headers:{"Content-Type":"application/xml"}, body:xml }); if(r.status<400) ok++; } catch(_) {}
    }
    this._message = ok===ips.length ? `? Preset ${this._selectedSlot} saved: ${station.name}` : `?? Saved to ${ok}/${ips.length} speakers`;
    this._saving = false;
    await this._loadPresets();
    this._render();
    setTimeout(() => { this._message=null; this._render(); }, 4000);
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
    .vol-row{display:flex;align-items:center;gap:10px;padding:10px 0 4px}
    .vol-label{font-size:12px;color:var(--secondary-text-color);flex-shrink:0;width:26px;text-align:center}
    .vol-slider{flex:1;-webkit-appearance:none;appearance:none;height:4px;border-radius:4px;background:var(--divider-color,#444);outline:none;cursor:pointer}
    .vol-slider::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;border-radius:50%;background:var(--primary-color,#03a9f4);cursor:pointer}
    .vol-slider::-moz-range-thumb{width:18px;height:18px;border-radius:50%;background:var(--primary-color,#03a9f4);cursor:pointer;border:none}
    .vol-val{font-size:12px;color:var(--primary-text-color);flex-shrink:0;width:32px;text-align:right}
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
    .pandora-btns{display:flex;gap:6px;flex-shrink:0}
    .play-btn{padding:5px 10px;border-radius:6px;border:none;background:rgba(3,169,244,.2);color:var(--primary-color);font-size:12px;font-weight:600;cursor:pointer}
    .play-btn:hover{background:rgba(3,169,244,.35)}
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

  _render() {
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
        <h3>Pandora</h3>
        <div style="font-size:11px;color:var(--secondary-text-color);margin-bottom:10px;">Select a preset slot to save to, then click Save on any station.</div>
        <div class="chips">${chipsHtml}</div>
        ${this._message?`<div class="message">${this._message}</div>`:''}
        <div class="pandora-list">${stationHtml}</div>
      </div></ha-card>`;

      this.shadowRoot.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => { this._selectedSlot=parseInt(c.dataset.slot); this._render(); }));
      this.shadowRoot.querySelectorAll('.play-btn').forEach(b => b.addEventListener('click', () => this._playPandora({ location:b.dataset.loc, sourceAccount:b.dataset.acct, name:b.dataset.name, art:b.dataset.art })));
      this.shadowRoot.querySelectorAll('.save-btn').forEach(b => b.addEventListener('click', () => this._savePandoraPreset({ location:b.dataset.loc, sourceAccount:b.dataset.acct, name:b.dataset.name, art:b.dataset.art })));
      return;
    }
    if (this._mode === "speaker") {
      this.shadowRoot.innerHTML = `<style>${this._styles()}</style><ha-card>${this._renderSpeaker()}</ha-card>`;
      const vs = this.shadowRoot.getElementById("vol-slider");
      const vv = this.shadowRoot.getElementById("vol-val");
      vs?.addEventListener("input", () => { vv.textContent = vs.value + "%"; });
      vs?.addEventListener("change", () => this._setVolumeAll(parseInt(vs.value)));
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
      body = `<div class="card"><h3>Presets</h3>${chipsHtml}<div class="preset-grid">${grid}</div><div class="vol-row"><span class="vol-label">&#x1F50A;</span><input class="vol-slider" id="vol-slider" type="range" min="0" max="100" value="30"/><span class="vol-val" id="vol-val">30%</span></div><button class="off-btn" id="off-btn">Turn Off All Speakers</button></div>`;
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
      body = `<div class="card"><h3>TuneIn Preset Editor</h3><div class="chips">${chips}</div><div class="search-row"><input class="search-input" id="si" type="text" placeholder="Search TuneIn (e.g. WUWM, jazz, NPR)"/><button class="search-btn" id="sb" ${this._loading?"disabled":""}>${this._loading?"...":"Search"}</button></div>${this._message?`<div class="message">${this._message}</div>`:""}<div class="results">${results}</div></div>`;
    }
    this.shadowRoot.innerHTML = `<style>${this._styles()}</style><ha-card>${body}</ha-card>`;
    if (p) {
      this.shadowRoot.querySelectorAll(".preset-btn").forEach(b => b.addEventListener("click", () => { const pr = this._currentPresets.find(x=>x.id===parseInt(b.dataset.id)); if(pr) this._playPreset(pr); }));
      this.shadowRoot.getElementById("off-btn")?.addEventListener("click", () => this._turnOffAll());
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