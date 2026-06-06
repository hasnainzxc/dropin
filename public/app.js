const driftToleranceSeconds = 0.75;
const hardSeekToleranceSeconds = 1.5;
const seekBroadcastCooldownMs = 1000;

const els = {
  authGate: document.querySelector("#authGate"),
  authForm: document.querySelector("#authForm"),
  authInput: document.querySelector("#authInput"),
  authError: document.querySelector("#authError"),
  roomId: document.querySelector("#roomId"),
  nameInput: document.querySelector("#nameInput"),
  searchForm: document.querySelector("#searchForm"),
  searchInput: document.querySelector("#searchInput"),
  searchTabButton: document.querySelector("#searchTabButton"),
  queueTabButton: document.querySelector("#queueTabButton"),
  searchPanel: document.querySelector("#searchPanel"),
  queuePanel: document.querySelector("#queuePanel"),
  searchMessage: document.querySelector("#searchMessage"),
  searchResults: document.querySelector("#searchResults"),
  queueAllButton: document.querySelector("#queueAllButton"),
  controlDeck: document.querySelector(".control-deck"),
  playButton: document.querySelector("#playButton"),
  pauseButton: document.querySelector("#pauseButton"),
  nextButton: document.querySelector("#nextButton"),
  authorityHint: document.querySelector("#authorityHint"),
  copyLinkButton: document.querySelector("#copyLinkButton"),
  newRoomButton: document.querySelector("#newRoomButton"),
  volumeInput: document.querySelector("#volumeInput"),
  emptyPlayer: document.querySelector("#emptyPlayer"),
  nowTitle: document.querySelector("#nowTitle"),
  playerDebug: document.querySelector("#playerDebug"),
  syncStatus: document.querySelector("#syncStatus"),
  syncLabel: document.querySelector("#syncStatus .sync-label"),
  queueList: document.querySelector("#queueList"),
  queueCount: document.querySelector("#queueCount"),
  participantList: document.querySelector("#participantList"),
  participantCount: document.querySelector("#participantCount"),
  toast: document.querySelector("#toast"),
  bottomTabs: document.querySelectorAll(".bottom-tab, .bottom-cta"),
  searchPanelEmpty: document.querySelector("#searchPanel"),
  queuePanelEmpty: document.querySelector("#queuePanel")
};

const clientId = loadClientId();
const clientColor = loadClientColor();
const state = {
  roomId: "",
  room: null,
  player: null,
  playerReady: false,
  applyingRemote: false,
  eventSource: null,
  searchTimer: null,
  searchAbort: null,
  pollTimer: null,
  driftTimer: null,
  heartbeatTimer: null,
  lastPlayerState: null,
  lastSeekBroadcastAt: 0,
  lastSeq: -1,
  lastQueueSig: "",
  lastParticipantSig: "",
  lastResults: null,
  lastBulkAddUrl: "",
  spotifyImporting: false,
  importJob: null
};

window.addEventListener("error", (event) => {
  console.error("Window error", event.message, event.filename, event.lineno);
  flashStatus("Client error", "bad");
});

window.addEventListener("unhandledrejection", (event) => {
  console.error("Unhandled rejection", event.reason);
  flashStatus("Client error", "bad");
});

init();

async function init() {
  els.nameInput.value = localStorage.getItem("sync-room-name") || randomName();
  els.volumeInput.value = localStorage.getItem("sync-room-volume") || "70";
  bindAuthEvents();
  await ensureAuthenticated();

  const params = new URLSearchParams(window.location.search);
  const hashRoom = window.location.hash.replace(/^#\/?/, "");
  state.roomId = sanitizeRoomId(params.get("room") || hashRoom || "");

  if (!state.roomId) {
    await createNewRoom();
  } else {
    updateUrlRoom(state.roomId);
  }

  els.roomId.textContent = state.roomId;
  bindEvents();
  refreshEmptyStates();
  await waitForYouTube();
  createPlayer();
  connectEvents();
  sendCommand({ type: "join" });
}

function bindEvents() {
  els.nameInput.addEventListener("change", () => {
    localStorage.setItem("sync-room-name", els.nameInput.value.trim() || "Listener");
    sendCommand({ type: "join" });
  });

  els.searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    runSearch(els.searchInput.value.trim());
  });

  els.searchInput.addEventListener("input", () => {
    window.clearTimeout(state.searchTimer);
    const query = els.searchInput.value.trim();
    if (query.length < 2) {
      if (state.searchAbort) state.searchAbort.abort();
      els.searchMessage.textContent = "Search a song or paste a YouTube link.";
      els.searchResults.replaceChildren();
      state.lastResults = null;
      state.lastBulkAddUrl = "";
      renderQueueAllButton();
      refreshEmptyStates();
      return;
    }
    if (looksLikeYouTubeUrl(query)) {
      els.searchMessage.textContent = /[?&]list=/.test(query)
        ? "Loading playlist..."
        : "Loading track...";
    }
    state.searchTimer = window.setTimeout(() => runSearch(query), 300);
    refreshEmptyStates();
  });

  els.searchTabButton.addEventListener("click", () => setRailTab("search"));
  els.queueTabButton.addEventListener("click", () => setRailTab("queue"));
  els.queueAllButton.addEventListener("click", queueAllItems);

  els.playButton.addEventListener("click", () => sendPlaybackCommand({ type: "play", position: getPlayerTime() }));
  els.pauseButton.addEventListener("click", () => sendPlaybackCommand({ type: "pause", position: getPlayerTime() }));
  els.nextButton.addEventListener("click", () => sendPlaybackCommand({ type: "next" }));
  els.copyLinkButton.addEventListener("click", shareRoomLink);
  els.newRoomButton.addEventListener("click", async () => {
    await createNewRoom();
    connectEvents();
    sendCommand({ type: "join" });
    showToast("Fresh room", "ok");
  });

  els.volumeInput.addEventListener("input", () => {
    localStorage.setItem("sync-room-volume", els.volumeInput.value);
    if (state.playerReady) state.player.setVolume(Number(els.volumeInput.value));
  });

  bindBottomBar();
}

function bindBottomBar() {
  for (const btn of els.bottomTabs) {
    btn.addEventListener("click", () => {
      const target = btn.dataset.bottom;
      if (target === "search") {
        setRailTab("search");
        scrollSideRail();
      } else if (target === "queue") {
        setRailTab("queue");
        scrollSideRail();
      } else if (target === "room") {
        const drawer = document.querySelector(".room-drawer");
        if (drawer) {
          drawer.open = true;
          scrollSideRail();
        }
      }
      updateBottomActive(target);
    });
  }
}

function updateBottomActive(active) {
  for (const btn of els.bottomTabs) {
    if (btn.classList.contains("bottom-cta")) continue;
    btn.classList.toggle("is-active", btn.dataset.bottom === active);
  }
}

function scrollSideRail() {
  const rail = document.querySelector(".side-rail");
  if (rail) rail.scrollIntoView({ behavior: "smooth", block: "start" });
}

function bindAuthEvents() {
  els.authForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitAuth();
  });
}

function setRailTab(tab) {
  const isSearch = tab === "search";
  els.searchTabButton.classList.toggle("is-active", isSearch);
  els.queueTabButton.classList.toggle("is-active", !isSearch);
  els.searchTabButton.setAttribute("aria-selected", String(isSearch));
  els.queueTabButton.setAttribute("aria-selected", String(!isSearch));
  els.searchPanel.classList.toggle("is-active", isSearch);
  els.queuePanel.classList.toggle("is-active", !isSearch);
  updateBottomActive(isSearch ? "search" : "queue");
}

async function ensureAuthenticated() {
  const response = await fetch("/api/auth/status");
  const data = await response.json().catch(() => ({ required: false, authenticated: true }));
  if (!data.required || data.authenticated) {
    els.authGate.hidden = true;
    return;
  }

  els.authGate.hidden = false;
  els.authInput.focus();
  await new Promise((resolve) => {
    els.authForm.addEventListener("dropin-authenticated", resolve, { once: true });
  });
}

async function submitAuth() {
  els.authError.textContent = "";
  const response = await fetch("/api/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: els.authInput.value })
  });

  if (!response.ok) {
    els.authError.textContent = "Wrong passcode.";
    els.authInput.select();
    return;
  }

  els.authInput.value = "";
  els.authGate.hidden = true;
  els.authForm.dispatchEvent(new Event("dropin-authenticated"));
}

function handleUnauthorized() {
  els.authGate.hidden = false;
  els.authError.textContent = "Passcode required.";
  els.authInput.focus();
  flashStatus("Locked", "warn");
}

async function createNewRoom() {
  const response = await fetch("/api/rooms", { method: "POST" });
  if (response.status === 401) {
    handleUnauthorized();
    return;
  }
  const room = await response.json();
  state.roomId = room.id;
  state.room = null;
  updateUrlRoom(state.roomId);
  els.roomId.textContent = state.roomId;
  els.searchResults.replaceChildren();
  els.searchMessage.textContent = "Search a song, then tap to add it.";
}

async function shareRoomLink() {
  const url = new URL(window.location.href);
  url.searchParams.set("room", state.roomId);
  const link = url.toString();
  const payload = {
    title: "DropIn",
    text: "Listen with me on DropIn",
    url: link
  };

  if (navigator.share && navigator.canShare?.(payload)) {
    try {
      await navigator.share(payload);
      return;
    } catch (error) {
      if (error?.name === "AbortError") return;
    }
  }

  await copyText(link);
  showToast("Room link copied", "ok");
}

async function copyText(value) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textArea = document.createElement("textarea");
  textArea.value = value;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.left = "-9999px";
  document.body.append(textArea);
  textArea.select();
  document.execCommand("copy");
  textArea.remove();
}

function looksLikeYouTubeUrl(value) {
  const str = String(value || "").trim();
  if (!str) return false;
  try {
    const url = new URL(str);
    const host = url.hostname.replace(/^www\./, "");
    return host === "youtu.be" || host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com");
  } catch {
    return false;
  }
}

function looksLikeSpotifyUrl(value) {
  const str = String(value || "").trim();
  if (!str) return false;
  if (/^spotify:(playlist|album|track):[a-zA-Z0-9]{22}\b/.test(str)) return true;
  try {
    const url = new URL(str);
    return url.hostname.replace(/^www\./, "") === "open.spotify.com";
  } catch {
    return false;
  }
}

function queueAllItems() {
  if (state.lastBulkAddUrl) {
    sendCommand({ type: "enqueue", sourceUrl: state.lastBulkAddUrl });
    showToast("Adding playlist to lineup", "ok");
    return;
  }
  const items = state.lastResults || [];
  if (items.length === 0) return;
  for (const item of items) {
    sendCommand({
      type: "enqueue",
      videoId: item.videoId,
      title: item.title,
      sourceUrl: item.sourceUrl,
      channelTitle: item.channelTitle,
      thumbnail: item.thumbnail,
      durationLabel: item.durationLabel
    });
  }
  showToast(`Added ${items.length} tracks`, "ok");
}

function renderQueueAllButton() {
  if (!els.queueAllButton) return;
  const items = state.lastResults || [];
  const show = items.length > 1;
  els.queueAllButton.hidden = !show;
  if (show) {
    const label = state.lastBulkAddUrl ? "Queue playlist" : "Queue all";
    els.queueAllButton.textContent = `${label} (${items.length})`;
  }
}

async function startSpotifyImport(url) {
  if (state.spotifyImporting) return;
  state.spotifyImporting = true;
  state.importJob = null;
  els.searchMessage.textContent = "Starting Spotify import…";
  renderImportPanel("loading");

  try {
    const response = await fetch(`/api/rooms/${state.roomId}/spotify-import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        clientId,
        clientName: els.nameInput.value.trim() || "Listener",
        clientColor
      })
    });

    if (response.status === 401) {
      handleUnauthorized();
      state.spotifyImporting = false;
      return;
    }

    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const errMsg = data?.error || "Spotify import failed.";
      els.searchMessage.textContent = errMsg;
      renderImportPanel("error", { error: errMsg });
      showToast(errMsg, "bad");
      state.spotifyImporting = false;
      return;
    }

    state.importJob = {
      jobId: data.jobId,
      total: data.total,
      done: 0,
      matchedCount: 0,
      unmatchedCount: 0,
      currentTitle: "",
      name: data.name,
      cover: data.cover,
      unmatched: []
    };

    renderImportPanel("progress", state.importJob);
    showToast(`Importing "${data.name}" (${data.total} tracks)`, "ok");
  } catch (error) {
    els.searchMessage.textContent = "Spotify import failed.";
    renderImportPanel("error", { error: "Network error" });
    showToast("Spotify import failed", "bad");
    state.spotifyImporting = false;
  }
}

function renderImportPanel(state, info = {}) {
  els.searchResults.replaceChildren();
  const container = document.createElement("div");
  container.className = "import-panel";

  if (state === "loading") {
    container.innerHTML = `
      <div class="import-spinner"></div>
      <p class="import-status">Fetching and matching tracks…</p>
      <p class="import-subtitle">This may take a moment for large playlists.</p>
    `;
  } else if (state === "progress") {
    const pct = info.total > 0 ? Math.round((info.done / info.total) * 100) : 0;
    const coverHtml = info.cover
      ? `<img class="import-cover" src="${info.cover}" alt="" loading="lazy">`
      : "";
    const nameHtml = info.name
      ? `<p class="import-playlist-name">${escapeHtml(info.name)}</p>`
      : "";
    const currentHtml = info.currentTitle
      ? `<p class="import-current"><span class="import-current__dot"></span>Matching: ${escapeHtml(info.currentTitle)}</p>`
      : "";
    container.innerHTML = `
      <div class="import-panel__header">
        ${coverHtml}
        <div class="import-panel__meta">
          ${nameHtml}
          <div class="import-panel__badges">
            <span class="source-pill--spotify">Spotify</span>
          </div>
        </div>
      </div>
      <div class="import-progress-wrap">
        <div class="import-progress-bar">
          <div class="import-progress-fill" style="width:${pct}%"></div>
        </div>
        <div class="import-progress-label">
          <span class="import-progress-count">${info.done} / ${info.total}</span>
          <span>${pct}%</span>
        </div>
      </div>
      ${currentHtml}
      <div class="import-stats">
        <span class="import-stat import-stat--ok">${info.matchedCount} matched</span>
        ${info.unmatchedCount > 0 ? `<span class="import-stat import-stat--warn">${info.unmatchedCount} not found</span>` : ""}
      </div>
    `;
  } else if (state === "error") {
    container.innerHTML = `
      <div class="import-icon import-icon--bad">
        <svg aria-hidden="true"><use href="#i-close"/></svg>
      </div>
      <p class="import-status">${info.error || "Import failed"}</p>
    `;
  } else if (state === "done") {
    const coverHtml = info.cover
      ? `<img class="import-cover" src="${info.cover}" alt="" loading="lazy">`
      : "";
    const nameHtml = info.name
      ? `<p class="import-playlist-name">${escapeHtml(info.name)}</p>`
      : "";
    const unmatchedHtml = (info.unmatched && info.unmatched.length > 0)
      ? `<details class="import-unmatched">
          <summary>${info.unmatched.length} couldn't match</summary>
          <ul>${info.unmatched.map((t) => `<li>${escapeHtml(t.title)}${t.artist ? ` — ${escapeHtml(t.artist)}` : ""}</li>`).join("")}</ul>
        </details>`
      : "";
    container.innerHTML = `
      <div class="import-panel__header">
        ${coverHtml}
        <div class="import-panel__meta">
          ${nameHtml}
          <div class="import-panel__badges">
            <span class="source-pill--spotify">Spotify</span>
          </div>
        </div>
      </div>
      <div class="import-icon import-icon--ok">
        <svg aria-hidden="true"><use href="#i-check"/></svg>
      </div>
      <p class="import-status">Import complete!</p>
      <div class="import-stats">
        <span class="import-stat import-stat--ok">${info.matchedCount} matched</span>
        ${info.unmatchedCount > 0 ? `<span class="import-stat import-stat--warn">${info.unmatchedCount} not found</span>` : ""}
      </div>
      ${unmatchedHtml}
    `;
  }

  els.searchResults.append(container);
}

async function runSearch(query) {
  if (query.length < 2) return;

  // Clear stuck import state on any non-Spotify search so the panel
  // resets without a page refresh.
  if (!looksLikeSpotifyUrl(query) && state.spotifyImporting) {
    state.spotifyImporting = false;
    state.importJob = null;
  }

  if (looksLikeSpotifyUrl(query)) {
    if (state.spotifyImporting) return;
    return startSpotifyImport(query);
  }
  if (state.searchAbort) state.searchAbort.abort();
  state.searchAbort = new AbortController();
  els.searchMessage.textContent = "Searching...";

  try {
    const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
      signal: state.searchAbort.signal
    });
    if (response.status === 401) {
      handleUnauthorized();
      return;
    }
    const data = await response.json().catch(() => ({ items: [] }));
    if (!response.ok) {
      els.searchResults.replaceChildren();
      els.searchMessage.textContent = data.error || "Search is unavailable.";
      return;
    }

    const items = data.items || [];
    state.lastResults = items;
    state.lastBulkAddUrl = data.bulkAddUrl || "";
    renderSearchResults(items);
    renderQueueAllButton();
    const sourceLabel = data.source === "playlist"
      ? `${items.length} tracks in playlist`
      : data.source === "video"
        ? "1 track"
        : items.length
          ? `${items.length} results`
          : "No results found.";
    els.searchMessage.textContent = sourceLabel;
    setRailTab("search");
    refreshEmptyStates();
  } catch (error) {
    if (error.name === "AbortError") return;
    els.searchResults.replaceChildren();
    els.searchMessage.textContent = "Search is unavailable right now.";
    state.lastResults = null;
    state.lastBulkAddUrl = "";
    renderQueueAllButton();
  }
}

function renderSearchResults(items) {
  els.searchResults.replaceChildren(
    ...items.map((item) => {
      const row = document.createElement("li");
      row.className = "result-card";
      row.tabIndex = 0;
      row.title = "Add to queue";

      const thumb = document.createElement("div");
      thumb.className = "result-thumb";
      if (item.thumbnail) {
        const img = document.createElement("img");
        img.src = item.thumbnail;
        img.alt = item.title;
        img.loading = "lazy";
        thumb.append(img);
      } else {
        thumb.append(thumbnailFallback());
      }
      if (item.durationLabel) {
        const duration = document.createElement("span");
        duration.className = "duration-badge";
        duration.textContent = item.durationLabel;
        thumb.append(duration);
      }

      const text = document.createElement("div");
      text.className = "result-body";

      const title = document.createElement("div");
      title.className = "result-title";
      title.textContent = item.title;

      const meta = document.createElement("div");
      meta.className = "result-meta";
      meta.append(metaPill(item.channelTitle || "YouTube"));

      const stats = document.createElement("div");
      stats.className = "result-stats";
      stats.append(
        textNode(formatViews(item.viewCount)),
        separator(),
        textNode(formatPublishedAt(item.publishedAt))
      );

      const description = document.createElement("div");
      description.className = "result-description";
      description.textContent = item.description || item.sourceUrl;

      text.append(title, meta, stats, description);
      const action = document.createElement("div");
      action.className = "result-action";
      action.innerHTML = svgUse("i-plus");
      action.setAttribute("aria-hidden", "true");

      const enqueue = () => {
        const shouldPlayNow = isHost() && !state.room?.player?.videoId;
        sendCommand({
          type: shouldPlayNow ? "load" : "enqueue",
          videoId: item.videoId,
          title: item.title,
          sourceUrl: item.sourceUrl,
          channelTitle: item.channelTitle,
          thumbnail: item.thumbnail,
          durationLabel: item.durationLabel
        });
        showToast(shouldPlayNow ? "Now playing" : "Added to lineup", "ok");
      };

      row.addEventListener("click", enqueue);
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          enqueue();
        }
      });

      row.append(thumb, text, action);
      return row;
    })
  );
}

function connectEvents() {
  if (state.eventSource) state.eventSource.close();
  if (state.pollTimer) {
    window.clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  const params = new URLSearchParams({
    clientId,
    name: els.nameInput.value.trim() || "Listener",
    color: clientColor
  });
  state.eventSource = new EventSource(`/api/rooms/${state.roomId}/events?${params.toString()}`);

  for (const eventName of ["hello", "state", "presence", "load", "enqueue", "play", "pause", "seek", "next", "jump", "remove", "host", "sync"]) {
    state.eventSource.addEventListener(eventName, (event) => {
      applyRoomState(JSON.parse(event.data), eventName);
    });
  }

  state.eventSource.addEventListener("import-progress", (event) => {
    const data = JSON.parse(event.data);
    if (state.importJob && data.jobId === state.importJob.jobId) {
      state.importJob.done = data.done;
      state.importJob.matchedCount = data.matchedCount;
      state.importJob.unmatchedCount = data.unmatchedCount;
      state.importJob.currentTitle = data.currentTitle;
      renderImportPanel("progress", state.importJob);
    }
  });

  state.eventSource.addEventListener("import-complete", (event) => {
    const data = JSON.parse(event.data);
    if (state.importJob && data.jobId === state.importJob.jobId) {
      state.importJob.matchedCount = data.matchedCount;
      state.importJob.unmatchedCount = data.unmatchedCount;
      state.importJob.unmatched = data.unmatched || [];
      renderImportPanel("done", state.importJob);
      const msg = `Added ${data.matchedCount} tracks from Spotify`;
      if (data.unmatchedCount > 0) {
        showToast(msg + ` (${data.unmatchedCount} not found)`, "warn");
      } else {
        showToast(msg, "ok");
      }
      if (data.cappedAt > 0) {
        showToast(
          `Only first ${data.cappedAt} tracks available without Spotify API credentials. Set SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET for full playlist.`,
          "warn"
        );
      }
      state.spotifyImporting = false;
      state.importJob = null;
    }
  });

  state.eventSource.addEventListener("open", () => {
    flashStatus("In sync", "ok");
  });
  state.eventSource.addEventListener("error", () => {
    flashStatus("Reconnecting", "warn");
    startPollingFallback();
  });
}

async function sendCommand(command) {
  const payload = {
    ...command,
    clientId,
    clientName: els.nameInput.value.trim() || "Listener",
    clientColor
  };

  try {
    const response = await fetch(`/api/rooms/${state.roomId}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (response.status === 401) {
      handleUnauthorized();
      return;
    }

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Command failed" }));
      flashStatus(error.error || "Command failed", "bad");
      return;
    }

    const room = await response.json().catch(() => null);
    if (room) applyRoomState(room, command.type || "state");
  } catch (error) {
    console.error("Command failed", error);
    flashStatus("Command blocked", "bad");
  }
}

function startPollingFallback() {
  if (state.pollTimer) return;
  state.pollTimer = window.setInterval(async () => {
    try {
      const response = await fetch(`/api/rooms/${state.roomId}`);
      if (response.status === 401) {
        handleUnauthorized();
        return;
      }
      if (response.ok) {
        applyRoomState(await response.json(), "poll");
      }
    } catch {
      // The EventSource retry loop and this poller will keep the room moving.
    }
  }, 2500);
}

function applyRoomState(room, eventName) {
  if (Number.isFinite(room.seq) && room.seq < state.lastSeq) return;
  if (Number.isFinite(room.seq)) state.lastSeq = room.seq;
  state.room = room;
  renderRoom(room);

  if (!state.playerReady) return;
  const remote = room.player;
  if (!remote.videoId) {
    els.emptyPlayer.classList.remove("is-hidden");
    return;
  }

  const currentVideo = state.player?.getVideoData?.()?.video_id;
  const desiredTime = effectiveRemotePosition(room);

  if (isHost() && (eventName === "sync" || eventName === "heartbeat")) return;

  state.applyingRemote = true;

  if (currentVideo !== remote.videoId) {
    debugPlayer(`Loading ${remote.videoId}`);
    state.player.loadVideoById(remote.videoId, desiredTime + (remote.playing ? 0.2 : 0));
    state.player.setVolume(Number(els.volumeInput.value));
  } else if (eventName === "seek" || eventName === "jump") {
    debugPlayer(`Seeking ${Math.round(desiredTime)}s`);
    state.player.seekTo(desiredTime, true);
  } else {
    correctDrift(desiredTime);
  }

  if (remote.playing) {
    state.player.playVideo();
  } else {
    state.player.pauseVideo();
    correctDrift(desiredTime);
  }

  els.emptyPlayer.classList.add("is-hidden");
  window.setTimeout(() => {
    state.applyingRemote = false;
  }, 700);
}

function correctDrift(desiredTime) {
  const currentTime = getPlayerTime();
  const drift = Math.abs(currentTime - desiredTime);
  if (drift > driftToleranceSeconds) {
    state.player.seekTo(desiredTime, true);
  }
}

function watchLocalDrift() {
  if (!state.room?.player?.videoId || !state.playerReady || state.applyingRemote) return;
  const remote = state.room.player;
  const localTime = getPlayerTime();
  const desiredTime = effectiveRemotePosition(state.room);
  const drift = Math.abs(localTime - desiredTime);

  if (isHost()) {
    if (drift > hardSeekToleranceSeconds && Date.now() - state.lastSeekBroadcastAt > seekBroadcastCooldownMs) {
      state.lastSeekBroadcastAt = Date.now();
      sendCommand({ type: "seek", position: localTime });
    }
    return;
  }

  const states = window.YT?.PlayerState || {};
  if (remote.playing && ![states.PLAYING, states.BUFFERING].includes(state.lastPlayerState)) {
    state.player.playVideo();
  }
  if (!remote.playing && state.lastPlayerState === states.PLAYING) {
    state.player.pauseVideo();
  }

  if (drift > hardSeekToleranceSeconds && Date.now() - state.lastSeekBroadcastAt > seekBroadcastCooldownMs) {
    state.lastSeekBroadcastAt = Date.now();
    state.player.seekTo(desiredTime, true);
    return;
  }

  if (drift > driftToleranceSeconds) {
    state.player.seekTo(desiredTime, true);
  }
}

function renderRoom(room) {
  els.roomId.textContent = room.id;
  document.body.classList.toggle("is-host", isHost(room));
  document.body.classList.toggle("is-playing", Boolean(room.player?.playing && room.player?.videoId));
  els.nowTitle.textContent = room.player.title || (room.player.videoId ? room.player.videoId : "Drop in a track to start");
  updateControlState(room);
  const sessionQueue = buildSessionQueue(room);
  els.queueCount.textContent = String(sessionQueue.length);
  els.participantCount.textContent = String(room.participants.length);

  const queueSig = sessionQueue
    .map(({ track, status, index }) => `${track.id}|${status}|${index}|${track.thumbnail}|${track.title}|${track.addedBy}`)
    .join("~");
  if (queueSig !== state.lastQueueSig) {
    state.lastQueueSig = queueSig;
    renderQueueList(sessionQueue);
  }

  const participantSig = room.participants
    .map((p) => `${p.id}|${p.name}|${p.color}|${p.id === room.hostId ? "host" : ""}`)
    .join("~");
  if (participantSig !== state.lastParticipantSig) {
    state.lastParticipantSig = participantSig;
    renderParticipantList(room);
  }

  refreshEmptyStates();
}

function renderQueueList(sessionQueue) {
  els.queueList.replaceChildren(
    ...sessionQueue.map(({ track, status, index }) => {
      const item = document.createElement("li");
      item.className = `queue-card is-${status}`;
      item.tabIndex = 0;
      item.title = status === "current" ? "Currently playing" : isHost() ? "Play this track" : "Only the host can jump tracks";
      item.addEventListener("click", () => {
        if (status !== "current") sendPlaybackCommand({ type: "jump", index });
      });
      item.addEventListener("keydown", (event) => {
        if ((event.key === "Enter" || event.key === " ") && status !== "current") {
          event.preventDefault();
          sendPlaybackCommand({ type: "jump", index });
        }
      });

      const indexBadge = document.createElement("div");
      indexBadge.className = "queue-index";
      indexBadge.textContent = status === "current" ? "LIVE" : String(index + 1).padStart(2, "0");

      const thumb = document.createElement("div");
      thumb.className = "queue-thumb";
      if (track.thumbnail) {
        const img = document.createElement("img");
        img.src = track.thumbnail;
        img.alt = track.title || track.videoId;
        img.loading = "lazy";
        thumb.append(img);
      } else {
        thumb.append(thumbnailFallback());
      }
      if (track.durationLabel) {
        const duration = document.createElement("span");
        duration.className = "duration-badge";
        duration.textContent = track.durationLabel;
        thumb.append(duration);
      }

      const content = document.createElement("div");
      const title = document.createElement("div");
      title.className = "queue-title";
      title.textContent = track.title || track.videoId;
      const meta = document.createElement("div");
      meta.className = "queue-meta";
      meta.textContent = `${track.channelTitle || "YouTube"} - added by ${track.addedBy || "Someone"}`;
      const badge = document.createElement("div");
      badge.className = "queue-status";
      badge.textContent = statusLabel(status);
      content.append(title, meta, badge);

      const remove = document.createElement("button");
      remove.className = "remove-button";
      remove.type = "button";
      if (status === "current") {
        remove.disabled = true;
      } else {
        const label = status === "played" ? "Remove from history" : "Remove from queue";
        remove.title = label;
        remove.innerHTML = svgUse("i-close");
        remove.setAttribute("aria-label", label);
        remove.addEventListener("click", (event) => {
          event.stopPropagation();
          sendCommand({ type: "remove", trackId: track.id });
          showToast("Removed from lineup", "ok");
        });
      }

      item.append(indexBadge, thumb, content, remove);
      return item;
    })
  );
}

function renderParticipantList(room) {
  els.participantList.replaceChildren(
    ...room.participants.map((participant) => {
      const item = document.createElement("li");
      item.className = "participant-row";
      const dot = document.createElement("div");
      dot.className = "participant-dot";
      const baseColor = participant.color || hashColor(participant.id || participant.name || "?");
      dot.style.background = `linear-gradient(135deg, ${tintColor(baseColor, 18)}, ${baseColor})`;
      dot.textContent = (participant.name || "?").trim().charAt(0).toUpperCase() || "?";
      const content = document.createElement("div");
      const name = document.createElement("div");
      name.className = "participant-name";
      name.textContent = participant.name;
      const meta = document.createElement("div");
      meta.className = "participant-meta";
      meta.textContent = participant.id === room.hostId ? "Host" : "Listener";
      content.append(name, meta);
      item.append(dot, content);
      return item;
    })
  );
}

function buildSessionQueue(room) {
  return (room.playlist || []).map((track, index) => ({
    track,
    index,
    status: index < room.currentIndex ? "played" : index === room.currentIndex ? "current" : "upcoming"
  }));
}

function createPlayer() {
  state.player = new window.YT.Player("player", {
    height: "100%",
    width: "100%",
    host: "https://www.youtube.com",
    playerVars: {
      playsinline: 1,
      rel: 0,
      origin: window.location.origin
    },
    events: {
      onReady: () => {
        state.playerReady = true;
        state.player.setVolume(Number(els.volumeInput.value));
        flashStatus("Ready", "ok");
        debugPlayer("Ready");
        if (state.room) applyRoomState(state.room, "ready");
      },
      onStateChange: (event) => handlePlayerStateChange(event.data),
      onError: (event) => {
        flashStatus(`YouTube error ${event.data}`, "bad");
        debugPlayer(`YouTube error ${event.data}`);
      }
    }
  });

  state.driftTimer = window.setInterval(watchLocalDrift, 750);
  state.heartbeatTimer = window.setInterval(sendHostHeartbeat, 1000);
}

function handlePlayerStateChange(playerState) {
  const changed = state.lastPlayerState !== playerState;
  state.lastPlayerState = playerState;
  const states = window.YT.PlayerState;
  document.body.classList.toggle("is-playing", playerState === states.PLAYING);
  if (state.applyingRemote || !changed) return;
  debugPlayer(`Player state ${playerState}`);
  if (!isHost()) {
    flashStatus("Host controls room", "warn");
    return;
  }
  if (playerState === states.PLAYING) {
    sendCommand({ type: "play", position: getPlayerTime() });
  }
  if (playerState === states.PAUSED) {
    sendCommand({ type: "pause", position: getPlayerTime() });
  }
  if (playerState === states.ENDED) {
    sendCommand({ type: "next" });
  }
}

function sendHostHeartbeat() {
  if (!isHost() || !state.playerReady || !state.room?.player?.videoId || state.applyingRemote) return;
  const states = window.YT.PlayerState;
  const playerState = state.player.getPlayerState?.();
  sendCommand({
    type: "heartbeat",
    position: getPlayerTime(),
    playing: playerState === states.PLAYING || playerState === states.BUFFERING
  });
}

function sendPlaybackCommand(command) {
  if (!isHost()) {
    flashStatus("Host controls playback", "warn");
    return;
  }
  sendCommand(command);
}

function waitForYouTube() {
  if (window.YT?.Player) return Promise.resolve();
  return new Promise((resolve) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previous === "function") previous();
      resolve();
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    script.onerror = () => {
      flashStatus("YouTube API blocked", "bad");
      debugPlayer("YouTube API script blocked");
    };
    debugPlayer("Loading YouTube player");
    document.head.append(script);
  });
}

function effectiveRemotePosition(room) {
  const player = room?.player || {};
  const base = Number(player.position || 0);
  if (!player.playing) return base;
  const serverTime = Number(room.serverTime || Date.now());
  const elapsed = Math.max(0, (Date.now() - serverTime) / 1000);
  return base + elapsed;
}

function getPlayerTime() {
  if (!state.playerReady || !state.player?.getCurrentTime) return 0;
  return Number(state.player.getCurrentTime() || 0);
}

function isHost(room = state.room) {
  return Boolean(room?.hostId && room.hostId === clientId);
}

function updateControlState(room) {
  const canControl = isHost(room);
  const hasVideo = Boolean(room.player?.videoId);
  els.controlDeck.dataset.mode = canControl ? "Host deck" : "Listener mode";
  els.authorityHint.textContent = canControl
    ? "You're steering the room"
    : "Host steers playback — you can still queue";
  for (const button of [els.playButton, els.pauseButton, els.nextButton]) {
    if (!button.dataset.title) button.dataset.title = button.title;
    button.disabled = !hasVideo;
    button.title = canControl ? button.dataset.title : "Only the host can control playback";
  }
}

function statusLabel(status) {
  if (status === "current") return "Live";
  if (status === "played") return "Done";
  return "Next";
}

function textNode(value) {
  return document.createTextNode(value || "");
}

function separator() {
  const span = document.createElement("span");
  span.textContent = "-";
  return span;
}

function metaPill(value) {
  const span = document.createElement("span");
  span.className = "meta-pill";
  span.textContent = value || "";
  return span;
}

function thumbnailFallback() {
  const fallback = document.createElement("div");
  fallback.className = "thumb-fallback";
  fallback.innerHTML = svgUse("i-music");
  return fallback;
}

function svgUse(id) {
  return `<svg aria-hidden="true"><use href="#${id}"/></svg>`;
}

function refreshEmptyStates() {
  if (els.searchPanelEmpty) {
    const hasResults = els.searchResults && els.searchResults.children.length > 0;
    const hasQuery = els.searchInput && els.searchInput.value.trim().length >= 2;
    els.searchPanelEmpty.classList.toggle("is-empty", !hasResults && !hasQuery);
  }
  if (els.queuePanelEmpty) {
    const hasQueue = els.queueList && els.queueList.children.length > 0;
    els.queuePanelEmpty.classList.toggle("is-empty", !hasQueue);
  }
}

function showToast(message, level = "ok") {
  if (!els.toast) return;
  els.toast.dataset.message = message;
  els.toast.dataset.level = level;
  els.toast.classList.add("is-visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    els.toast.classList.remove("is-visible");
  }, 2200);
}

function hashColor(seed) {
  const palette = [
    "#ff6f4f", "#ffd166", "#7ce7bd", "#93e9ff",
    "#d087ff", "#ff7b8d", "#7c9cff", "#f4c95d"
  ];
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  return palette[Math.abs(hash) % palette.length];
}

function tintColor(hex, amount = 16) {
  const value = hex.replace("#", "");
  if (value.length !== 6) return hex;
  const num = parseInt(value, 16);
  const r = Math.min(255, ((num >> 16) & 0xff) + amount);
  const g = Math.min(255, ((num >> 8) & 0xff) + amount);
  const b = Math.min(255, (num & 0xff) + amount);
  return `rgb(${r}, ${g}, ${b})`;
}

function formatViews(value) {
  if (value == null || value === "") return "views unavailable";
  const str = String(value).trim();
  if (/\D/.test(str)) return str;
  const count = Number(str);
  if (!count) return "views unavailable";
  if (count >= 1_000_000_000) return `${trimNumber(count / 1_000_000_000)}B views`;
  if (count >= 1_000_000) return `${trimNumber(count / 1_000_000)}M views`;
  if (count >= 1_000) return `${trimNumber(count / 1_000)}K views`;
  return `${count} views`;
}

function trimNumber(value) {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
}

function formatPublishedAt(value) {
  if (!value) return "date unavailable";
  const str = String(value).trim();
  const date = new Date(str);
  if (!Number.isNaN(date.getTime()) && /\d{4}/.test(str)) {
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric"
    }).format(date);
  }
  return str || "date unavailable";
}

function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function sanitizeRoomId(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 48);
}

function updateUrlRoom(roomId) {
  const url = new URL(window.location.href);
  url.searchParams.set("room", roomId);
  window.history.replaceState({}, "", url);
}

function loadClientId() {
  const key = "sync-room-client-id";
  let value = localStorage.getItem(key);
  if (!value) {
    value = crypto.randomUUID();
    localStorage.setItem(key, value);
  }
  return value;
}

function loadClientColor() {
  const key = "sync-room-client-color";
  let value = localStorage.getItem(key);
  if (!value) {
    const colors = ["#4fc3a1", "#f4c95d", "#7c9cff", "#ff9f7a", "#d087ff"];
    value = colors[Math.floor(Math.random() * colors.length)];
    localStorage.setItem(key, value);
  }
  return value;
}

function randomName() {
  const names = ["Listener", "DJ", "Queue enjoyer", "Sync pilot", "Late joiner"];
  return `${names[Math.floor(Math.random() * names.length)]} ${Math.floor(Math.random() * 90 + 10)}`;
}

function debugPlayer(message) {
  if (els.playerDebug) els.playerDebug.textContent = message;
  console.debug("[player]", message);
}

function flashStatus(text, level) {
  if (els.syncLabel) {
    els.syncLabel.textContent = text;
  } else {
    els.syncStatus.textContent = text;
  }
  els.syncStatus.classList.toggle("is-warn", level === "warn");
  els.syncStatus.classList.toggle("is-bad", level === "bad");
}
