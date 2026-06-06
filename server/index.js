import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { Innertube } from "youtubei.js";
import { fetchSpotifyTracks } from "./spotify.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const rootDir = normalize(join(__dirname, ".."));
const publicDir = join(rootDir, "public");
const port = Number(process.env.PORT ?? 8787);

loadEnvFile();

const rooms = new Map();

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"]
]);

function now() {
  return Date.now();
}

function loadEnvFile() {
  const envPath = join(rootDir, ".env");
  if (!existsSync(envPath)) return;

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (!key || process.env[key] != null) continue;
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function createRoom(id) {
  return {
    id,
    seq: 0,
    hostId: null,
    participants: new Map(),
    clients: new Map(),
    player: {
      videoId: null,
      title: "",
      sourceUrl: "",
      channelTitle: "",
      thumbnail: "",
      durationLabel: "",
      addedBy: "",
      playing: false,
      position: 0,
      updatedAt: now()
    },
    queue: [],
    playlist: [],
    currentIndex: -1,
    history: [],
    createdAt: now()
  };
}

function getRoom(id) {
  const safeId = sanitizeRoomId(id);
  if (!rooms.has(safeId)) {
    rooms.set(safeId, createRoom(safeId));
  }
  return rooms.get(safeId);
}

function sanitizeRoomId(value) {
  const input = String(value || "").trim().toLowerCase();
  const cleaned = input.replace(/[^a-z0-9_-]/g, "").slice(0, 48);
  return cleaned || randomRoomId();
}

function randomRoomId() {
  return randomUUID().slice(0, 8);
}

function effectivePlayer(player) {
  if (!player.playing) return { ...player };
  const elapsed = Math.max(0, (now() - player.updatedAt) / 1000);
  return {
    ...player,
    position: player.position + elapsed
  };
}

function snapshot(room) {
  return {
    id: room.id,
    seq: room.seq,
    hostId: room.hostId,
    participants: [...room.participants.values()],
    player: effectivePlayer(room.player),
    queue: room.queue,
    playlist: room.playlist,
    currentIndex: room.currentIndex,
    history: room.playlist.slice(0, Math.max(0, room.currentIndex)),
    serverTime: now()
  };
}

function broadcast(room, event = "state") {
  const payload = `event: ${event}\ndata: ${JSON.stringify(snapshot(room))}\n\n`;
  for (const client of room.clients.values()) {
    client.write(payload);
  }
}

function broadcastRaw(room, eventType, data) {
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of room.clients.values()) {
    client.write(payload);
  }
}

function touchRoom(room) {
  room.seq += 1;
}

function isPlaybackCommand(type) {
  return ["load", "play", "pause", "seek", "next", "jump", "heartbeat"].includes(type);
}

function requireHost(room, clientId, type) {
  if (!isPlaybackCommand(type)) return;
  if (!clientId || room.hostId !== clientId) {
    const err = new Error("Only the host can control playback.");
    err.status = 403;
    throw err;
  }
}

function promoteHost(room) {
  const nextHost = [...room.clients.keys()][0] || null;
  if (room.hostId !== nextHost) {
    room.hostId = nextHost;
    return true;
  }
  return false;
}

function setJson(res, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
}

function sendJson(res, data, status = 200) {
  setJson(res, status);
  res.end(JSON.stringify(data));
}

function authPassword() {
  return process.env.SYNC_ROOM_PASSWORD || process.env.SITE_PASSWORD || "";
}

function authToken(password) {
  return createHash("sha256").update(`dropin:${password}`).digest("hex");
}

function cookieValue(req, name) {
  const cookie = req.headers.cookie || "";
  for (const part of cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}

function isAuthenticated(req) {
  const password = authPassword();
  if (!password) return true;
  return cookieValue(req, "dropin_auth") === authToken(password);
}

async function handleAuth(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/auth/status") {
    const required = Boolean(authPassword());
    sendJson(res, { required, authenticated: !required || isAuthenticated(req) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/auth") {
    const configured = authPassword();
    if (!configured) {
      sendJson(res, { ok: true });
      return true;
    }

    const body = await readBody(req);
    if (String(body.password || "") !== configured) {
      sendJson(res, { error: "Invalid passcode" }, 401);
      return true;
    }

    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": `dropin_auth=${authToken(configured)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`
    });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  return false;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function normalizeTrack(input) {
  const sourceUrl = String(input.sourceUrl || input.url || "").trim();
  const videoId = String(input.videoId || extractYouTubeId(sourceUrl) || "").trim();
  if (!videoId) {
    const err = new Error("A valid YouTube URL or video id is required.");
    err.status = 400;
    throw err;
  }
  return {
    id: randomUUID(),
    videoId,
    title: String(input.title || "YouTube video").trim().slice(0, 120),
    sourceUrl: sourceUrl || `https://www.youtube.com/watch?v=${videoId}`,
    channelTitle: String(input.channelTitle || "").trim().slice(0, 120),
    thumbnail: String(input.thumbnail || "").trim(),
    durationLabel: String(input.durationLabel || "").trim().slice(0, 24),
    addedBy: String(input.clientName || "Someone").trim().slice(0, 80),
    addedAt: now()
  };
}

function playerFromTrack(track, position = 0) {
  return {
    videoId: track.videoId,
    title: track.title,
    sourceUrl: track.sourceUrl,
    channelTitle: track.channelTitle,
    thumbnail: track.thumbnail,
    durationLabel: track.durationLabel,
    addedBy: track.addedBy,
    playing: true,
    position,
    updatedAt: now()
  };
}

function syncQueueFromPlaylist(room) {
  room.queue = room.currentIndex >= 0 ? room.playlist.slice(room.currentIndex + 1) : [...room.playlist];
}

function loadPlaylistIndex(room, index, position = 0) {
  if (index < 0 || index >= room.playlist.length) {
    const err = new Error("Track is no longer in the session list.");
    err.status = 404;
    throw err;
  }
  room.currentIndex = index;
  room.player = playerFromTrack(room.playlist[index], position);
  syncQueueFromPlaylist(room);
}

function proxyThumbnailUrl(url) {
  return url && /^https:\/\/(i\.ytimg\.com|img\.youtube\.com)\//.test(url)
    ? `/api/thumb?url=${encodeURIComponent(url)}`
    : "";
}

let innertubePromise = null;
function getInnertube() {
  if (!innertubePromise) {
    innertubePromise = Innertube.create().catch((err) => {
      innertubePromise = null;
      throw err;
    });
  }
  return innertubePromise;
}

function textOf(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (typeof value.toString === "function") {
      const out = value.toString();
      return out === "[object Object]" ? "" : out;
    }
  }
  return "";
}

function pickThumbnail(thumbnails) {
  if (!Array.isArray(thumbnails) || thumbnails.length === 0) return "";
  const sorted = [...thumbnails].sort((a, b) => (b?.width || 0) - (a?.width || 0));
  return sorted[0]?.url || "";
}

function formatSecondsLabel(seconds) {
  const total = Number(seconds);
  if (!Number.isFinite(total) || total <= 0) return "";
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function extractPlaylistId(value) {
  const input = String(value || "").trim();
  if (!input) return "";
  if (/^(PL|OL|UU|LL|FL|RD)[a-zA-Z0-9_-]{10,}$/.test(input)) return input;
  try {
    const url = new URL(input);
    const host = url.hostname.replace(/^www\./, "");
    if (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com") || host === "youtu.be") {
      return url.searchParams.get("list") || "";
    }
  } catch {
    return "";
  }
  return "";
}

function extractSpotifyRef(value) {
  const input = String(value || "").trim();
  if (!input) return null;

  const uriMatch = input.match(/^spotify:(playlist|album|track):([a-zA-Z0-9]{22})\b/);
  if (uriMatch) return { type: uriMatch[1], id: uriMatch[2] };

  try {
    const url = new URL(input);
    const host = url.hostname.replace(/^www\./, "");
    if (host !== "open.spotify.com") return null;

    const parts = url.pathname.split("/").filter(Boolean);
    const validTypes = ["playlist", "album", "track"];
    const typeIdx = parts.findIndex((p) => validTypes.includes(p));
    if (typeIdx >= 0 && parts[typeIdx + 1]) {
      const id = parts[typeIdx + 1].split("?")[0];
      return { type: parts[typeIdx], id };
    }
  } catch {
    return null;
  }
  return null;
}

const MAX_PLAYLIST_TRACKS = 100;

async function fetchPlaylistTracks(playlistId) {
  let yt;
  try {
    yt = await getInnertube();
  } catch (cause) {
    const err = new Error("YouTube search backend failed to initialize.");
    err.status = 502;
    err.cause = cause;
    throw err;
  }

  let playlist;
  try {
    playlist = await yt.getPlaylist(playlistId);
  } catch (cause) {
    const err = new Error("Could not load that playlist (private, region-locked, or removed).");
    err.status = 404;
    err.cause = cause;
    throw err;
  }

  const videos = Array.isArray(playlist?.videos) ? playlist.videos : Array.isArray(playlist?.items) ? playlist.items : [];
  return videos
    .map((video) => {
      const videoId = video?.id || video?.video_id || "";
      if (!videoId) return null;
      const durationText = textOf(video.duration) || textOf(video.length_text);
      const durationSeconds = video?.duration?.seconds ?? 0;
      return {
        videoId,
        title: textOf(video.title) || "YouTube video",
        sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
        channelTitle: textOf(video?.author?.name),
        thumbnail: proxyThumbnailUrl(pickThumbnail(video.thumbnails)),
        durationLabel: durationText || formatSecondsLabel(durationSeconds)
      };
    })
    .filter(Boolean)
    .slice(0, MAX_PLAYLIST_TRACKS);
}

async function fetchVideoInfo(videoId) {
  const sourceUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(sourceUrl)}&format=json`;

  let response;
  try {
    response = await fetch(oembedUrl);
  } catch (cause) {
    const err = new Error("Could not reach YouTube to resolve that video.");
    err.status = 502;
    err.cause = cause;
    throw err;
  }

  if (!response.ok) {
    const err = new Error("Could not load that video (private, removed, or region-locked).");
    err.status = response.status === 401 || response.status === 404 ? 404 : 502;
    throw err;
  }

  const data = await response.json().catch(() => ({}));
  const thumbUrl = typeof data.thumbnail_url === "string" ? data.thumbnail_url : "";
  return {
    videoId,
    title: String(data.title || "YouTube video"),
    description: "",
    channelId: "",
    channelTitle: String(data.author_name || ""),
    publishedAt: "",
    liveBroadcastContent: "none",
    thumbnails: thumbUrl ? [{ url: thumbUrl }] : [],
    thumbnail: proxyThumbnailUrl(thumbUrl),
    sourceUrl,
    durationLabel: "",
    viewCount: ""
  };
}

async function searchYouTube(query) {
  const playlistId = extractPlaylistId(query);
  if (playlistId) {
    const items = await fetchPlaylistTracks(playlistId);
    return {
      items,
      source: "playlist",
      bulkAddUrl: items.length > 0 ? query : ""
    };
  }

  const directId = extractYouTubeId(query);
  if (directId && /^https?:\/\//i.test(query.trim())) {
    const item = await fetchVideoInfo(directId);
    return { items: [item], source: "video" };
  }

  let yt;
  try {
    yt = await getInnertube();
  } catch (cause) {
    const err = new Error("YouTube search backend failed to initialize.");
    err.status = 502;
    err.cause = cause;
    throw err;
  }

  let results;
  try {
    results = await yt.search(query, { type: "video", safe_search: true });
  } catch (cause) {
    const err = new Error("YouTube search failed.");
    err.status = 502;
    err.cause = cause;
    throw err;
  }

  const videos = Array.isArray(results.videos) ? results.videos : [];
  const items = videos
    .map((video) => {
      const videoId = video?.id || video?.video_id || "";
      if (!videoId) return null;
      const durationText = textOf(video.duration) || textOf(video.length_text);
      const durationSeconds = video?.duration?.seconds ?? 0;
      const thumbUrl = pickThumbnail(video.thumbnails);
      return {
        videoId,
        title: textOf(video.title) || "YouTube video",
        description: textOf(video.description_snippet) || textOf(video.description),
        channelId: video?.author?.id || "",
        channelTitle: textOf(video?.author?.name),
        publishedAt: textOf(video.published),
        liveBroadcastContent: video?.is_live ? "live" : "none",
        thumbnails: video.thumbnails || [],
        thumbnail: proxyThumbnailUrl(thumbUrl),
        sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
        durationLabel: durationText || formatSecondsLabel(durationSeconds),
        viewCount: textOf(video.short_view_count) || textOf(video.view_count)
      };
    })
    .filter(Boolean);

  return { items, source: "search" };
}

function parseDurationToSeconds(label) {
  if (!label || typeof label !== "string") return 0;
  const parts = label.split(":").map(Number);
  if (parts.some(isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return 0;
}

function parseViewCount(text) {
  if (!text || typeof text !== "string") return 0;
  // "367M views" -> 367000000, "3.8M views" -> 3800000, "848K views" -> 848000, "367,353,891 views" -> 367353891
  const cleaned = text.replace(/,/g, "");
  const mMatch = cleaned.match(/^([\d.]+)\s*M/);
  if (mMatch) return Math.round(parseFloat(mMatch[1]) * 1_000_000);
  const kMatch = cleaned.match(/^([\d.]+)\s*K/);
  if (kMatch) return Math.round(parseFloat(kMatch[1]) * 1_000);
  const numMatch = cleaned.match(/^([\d.]+)/);
  if (numMatch) return Math.round(parseFloat(numMatch[1]));
  return 0;
}

function scoreVideoMatch(spotifyTrack, ytVideo) {
  const ytTitle = (textOf(ytVideo.title) || "").toLowerCase();
  const ytChannel = (textOf(ytVideo?.author?.name) || "").toLowerCase();
  const spTitle = (spotifyTrack.title || "").toLowerCase();
  const spArtist = (spotifyTrack.artist || "").toLowerCase();

  let score = 0;

  // 1. Token overlap (+3/token) + title-containment ratio
  const spTokens = spTitle.split(/\s+/).filter((t) => t.length > 2);
  let titleTokenHits = 0;
  for (const token of spTokens) {
    if (ytTitle.includes(token)) { score += 3; titleTokenHits++; }
  }
  // titleContainment gates the official-content boost (signal 6) so a wrong-but-official
  // same-album video can't outrank the correct title track (e.g. "Main Tumhara" vs "Dil Bechara").
  const titleContainment = spTokens.length > 0 ? titleTokenHits / spTokens.length : 1;
  if (spTokens.length >= 2 && titleContainment < 0.5) score -= 12;

  // 2. Artist match (+10 any artist, +12 ALL artists) — split multi-artist
  if (spArtist.length > 2) {
    const artists = spArtist.split(/[,;&]\s*/).map((a) => a.trim()).filter((a) => a.length > 2);
    let matchedArtists = 0;
    for (const artist of artists) {
      if (ytTitle.includes(artist) || ytChannel.includes(artist)) matchedArtists++;
    }
    if (matchedArtists === artists.length) score += 12; // all artists found
    else if (matchedArtists > 0) score += 10; // at least one artist found
  }

  // 3. Duration proximity (+5/<5s, +3/<15s, +1/<30s)
  const spSec = spotifyTrack.durationMs > 0 ? spotifyTrack.durationMs / 1000 : 0;
  let ytSec = ytVideo?.duration?.seconds ?? 0;
  if (ytSec === 0) {
    const durLabel = textOf(ytVideo.duration) || textOf(ytVideo.length_text) || "";
    ytSec = parseDurationToSeconds(durLabel);
  }
  if (spSec > 0 && ytSec > 0) {
    const diff = Math.abs(ytSec - spSec);
    if (diff < 5) score += 5;
    else if (diff < 15) score += 3;
    else if (diff < 30) score += 1;
  }

  // 4. View count signal (+4/>10M, +3/>1M, +2/>100K, +1/>10K)
  const viewText = textOf(ytVideo.short_view_count) || textOf(ytVideo.view_count) || ytVideo.viewCount || "";
  const viewCount = parseViewCount(viewText);
  if (viewCount > 10_000_000) score += 4;
  else if (viewCount > 1_000_000) score += 3;
  else if (viewCount > 100_000) score += 2;
  else if (viewCount > 10_000) score += 1;

  // 5. Channel authority boost (+6 for major labels/vevo)
  const authorityKw = ["vevo", " - topic", "official", "records", "music india", "sony music", "t-series", "saregama", "zee music", "tips official", "universal music", "warner music", "island records", "capitol records", "republic records", "def jam", "atlantic records", "interscope", "cola boy"];
  for (const kw of authorityKw) {
    if (ytChannel.includes(kw)) { score += 6; break; }
  }

  // 6. Official/primary content boost (tiered) — only when the title actually
  // matches the song (containment >= 0.5), so an official video of the WRONG
  // song from the same album cannot win on the boost alone.
  const officialBoostAllowed = titleContainment >= 0.5;
  if (officialBoostAllowed) {
    if (ytTitle.includes("official music video") || ytTitle.includes("official video")) score += 8;
    else if (ytTitle.includes("official audio")) score += 5;
    else if (ytTitle.includes("official lyric video") || ytTitle.includes("lyrical")) score += 4;
    else if (ytTitle.includes("visualizer")) score += 3;
    else if (ytTitle.includes("lyric video")) score += 2;
    else if (ytTitle.includes("official")) score += 6;
  }

  // 7. Expanded junk penalty (-20 each)
  const junk = [
    "reaction", "1 hour", "2 hour", "3 hour", "loop", "karaoke", "nightcore",
    "sped up", "slowed", "reverb", "tutorial", "how to", "acoustic cover",
    "instrumental", "piano cover", "guitar cover", "bass cover", "drum cover",
    "edit", "mashup", "medley", "megamix", "dj mix", "extended mix",
    "radio edit", "club mix", "dub mix", "trap remix", "phonk", "drift phonk",
    "8d", "8d audio", "slowed and reverb", "bass boosted", "tiktok",
    "ringtone", "whatsapp status", "shorts", "ringtone"
  ];
  for (const word of junk) {
    if (ytTitle.includes(word)) score -= 20;
  }
  // "cover" only penalized if NOT an official release
  if (ytTitle.includes("cover") && !ytTitle.includes("official")) score -= 20;
  // "live" penalized only if not the official live version
  if (ytTitle.includes("live") && !ytTitle.includes("official") && !ytTitle.includes("vevo")) score -= 10;
  // "remix" penalized unless it's an official remix
  if (ytTitle.includes("remix") && !ytTitle.includes("official")) score -= 15;

  return score;
}

async function resolveSpotifyToYouTube(tracks, onProgress) {
  const yt = await getInnertube();
  const matched = [];
  const unmatched = [];
  const total = tracks.length;

  for (let i = 0; i < total; i++) {
    const track = tracks[i];
    const queries = [];
    const q1 = `${track.artist} ${track.title}`.trim();
    if (q1) queries.push(q1);
    const q2 = `${track.title} ${track.artist} official`.trim();
    if (q2 && q2 !== q1) queries.push(q2);
    const q3 = track.title.trim();
    if (q3 && q3 !== q1 && q3 !== q2) queries.push(q3);

    let bestVideo = null;
    let bestScore = -Infinity;

    for (let qi = 0; qi < queries.length; qi++) {
      if (bestScore >= 5) break;

      try {
        if (qi > 0) await new Promise((r) => setTimeout(r, 1000));

        const results = await yt.search(queries[qi], { type: "video", safe_search: true });
        const videos = Array.isArray(results.videos) ? results.videos : [];

        for (const video of videos) {
          const score = scoreVideoMatch(track, video);
          if (score > bestScore) {
            bestScore = score;
            bestVideo = video;
          }
        }
      } catch {
        // continue to next fallback query
      }
    }

    if (bestVideo && bestScore >= 5) {
      const videoId = bestVideo?.id || bestVideo?.video_id || "";
      const durationText = textOf(bestVideo?.duration) || textOf(bestVideo?.length_text);
      const durationSeconds = bestVideo?.duration?.seconds ?? 0;
      const thumbUrl = pickThumbnail(bestVideo?.thumbnails);

      const matchedTrack = {
        videoId,
        title: textOf(bestVideo?.title) || "YouTube video",
        sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
        channelTitle: textOf(bestVideo?.author?.name),
        thumbnail: proxyThumbnailUrl(thumbUrl),
        durationLabel: durationText || formatSecondsLabel(durationSeconds)
      };

      matched.push(matchedTrack);
      if (onProgress) {
        onProgress({ done: i + 1, total, track, matched: matchedTrack });
      }
    } else {
      unmatched.push({ title: track.title, artist: track.artist });
      if (onProgress) onProgress({ done: i + 1, total, track, matched: null });
    }
  }

  return { matched, unmatched };
}

async function resolveSpotifyToYouTubeAsync(room, tracks, opts) {
  const { jobId, clientId, clientName, clientColor, onProgress, onComplete } = opts;
  const yt = await getInnertube();
  const unmatched = [];
  const total = tracks.length;
  let matchedCount = 0;
  let isFirst = true;

  for (let i = 0; i < total; i++) {
    const track = tracks[i];
    const queries = [];
    const q1 = `${track.artist} ${track.title}`.trim();
    if (q1) queries.push(q1);
    const q2 = `${track.title} ${track.artist} official`.trim();
    if (q2 && q2 !== q1) queries.push(q2);
    const q3 = track.title.trim();
    if (q3 && q3 !== q1 && q3 !== q2) queries.push(q3);

    let bestVideo = null;
    let bestScore = -Infinity;

    for (let qi = 0; qi < queries.length; qi++) {
      if (bestScore >= 5) break;

      try {
        if (qi > 0) await new Promise((r) => setTimeout(r, 1000));

        const results = await yt.search(queries[qi], { type: "video", safe_search: true });
        const videos = Array.isArray(results.videos) ? results.videos : [];

        for (const video of videos) {
          const score = scoreVideoMatch(track, video);
          if (score > bestScore) {
            bestScore = score;
            bestVideo = video;
          }
        }
      } catch {
        // continue to next fallback query
      }
    }

    const done = i + 1;
    if (bestVideo && bestScore >= 5) {
      const videoId = bestVideo?.id || bestVideo?.video_id || "";
      const durationText = textOf(bestVideo?.duration) || textOf(bestVideo?.length_text);
      const durationSeconds = bestVideo?.duration?.seconds ?? 0;
      const thumbUrl = pickThumbnail(bestVideo?.thumbnails);

      const matchedTrack = {
        videoId,
        title: textOf(bestVideo?.title) || "YouTube video",
        sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
        channelTitle: textOf(bestVideo?.author?.name),
        thumbnail: proxyThumbnailUrl(thumbUrl),
        durationLabel: durationText || formatSecondsLabel(durationSeconds)
      };

      matchedCount++;
      const command = {
        type: (isFirst && !room.player.videoId && clientId === room.hostId) ? "load" : "enqueue",
        clientId,
        clientName,
        clientColor,
        ...matchedTrack
      };
      applyCommand(room, command);
      broadcast(room, "state");
      isFirst = false;
    } else {
      unmatched.push({ title: track.title, artist: track.artist });
    }

    if (onProgress) {
      onProgress(done, total, track.title, matchedCount, unmatched.length);
    }
  }

  if (onComplete) {
    onComplete(matchedCount, unmatched.length, unmatched);
  }
}

function extractYouTubeId(value) {
  const input = String(value || "").trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;

  try {
    const url = new URL(input);
    const host = url.hostname.replace(/^www\./, "");
    if (host === "youtu.be") {
      return url.pathname.split("/").filter(Boolean)[0] || "";
    }
    if (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) {
      if (url.searchParams.get("v")) return url.searchParams.get("v");
      const parts = url.pathname.split("/").filter(Boolean);
      const marker = parts.findIndex((part) => ["embed", "shorts", "live"].includes(part));
      if (marker >= 0 && parts[marker + 1]) return parts[marker + 1];
    }
  } catch {
    return "";
  }

  return "";
}

function updateParticipant(room, clientId, patch = {}) {
  const previous = room.participants.get(clientId) || {};
  const participant = {
    id: clientId,
    name: String(patch.name || previous.name || "Listener").slice(0, 48),
    color: String(patch.color || previous.color || "#7c9cff").slice(0, 24),
    joinedAt: previous.joinedAt || now(),
    lastSeenAt: now()
  };
  room.participants.set(clientId, participant);
  if (!room.hostId) room.hostId = clientId;
  return participant;
}

function applyCommand(room, command) {
  const clientId = String(command.clientId || "").slice(0, 80);
  if (clientId) {
    updateParticipant(room, clientId, {
      name: command.clientName,
      color: command.clientColor
    });
  }

  requireHost(room, clientId, command.type);

  switch (command.type) {
    case "join":
      return;

    case "load": {
      const track = normalizeTrack(command);
      room.playlist.push(track);
      loadPlaylistIndex(room, room.playlist.length - 1, Number(command.position || 0));
      touchRoom(room);
      return;
    }

    case "enqueue": {
      room.playlist.push(normalizeTrack(command));
      syncQueueFromPlaylist(room);
      touchRoom(room);
      return;
    }

    case "play": {
      const current = effectivePlayer(room.player);
      room.player = {
        ...room.player,
        playing: true,
        position: Number.isFinite(command.position) ? Number(command.position) : current.position,
        updatedAt: now()
      };
      touchRoom(room);
      return;
    }

    case "pause": {
      const current = effectivePlayer(room.player);
      room.player = {
        ...room.player,
        playing: false,
        position: Number.isFinite(command.position) ? Number(command.position) : current.position,
        updatedAt: now()
      };
      touchRoom(room);
      return;
    }

    case "seek": {
      room.player = {
        ...room.player,
        position: Math.max(0, Number(command.position || 0)),
        updatedAt: now()
      };
      touchRoom(room);
      return;
    }

    case "next": {
      const nextIndex = room.currentIndex + 1;
      if (nextIndex <= 0 || nextIndex >= room.playlist.length) {
        room.player = {
          ...room.player,
          playing: false,
          position: 0,
          updatedAt: now()
        };
        touchRoom(room);
        return;
      }
      loadPlaylistIndex(room, nextIndex, 0);
      touchRoom(room);
      return;
    }

    case "jump": {
      const index = Number(command.index);
      loadPlaylistIndex(room, index, 0);
      touchRoom(room);
      return;
    }

    case "heartbeat": {
      if (!room.player.videoId) return;
      const current = effectivePlayer(room.player);
      const position = Number(command.position);
      room.player = {
        ...room.player,
        playing: typeof command.playing === "boolean" ? command.playing : current.playing,
        position: Number.isFinite(position) ? Math.max(0, position) : current.position,
        updatedAt: now()
      };
      touchRoom(room);
      return;
    }

    case "remove": {
      const id = String(command.trackId || "");
      const index = room.playlist.findIndex((track) => track.id === id);
      if (index === -1) return;
      if (index === room.currentIndex) return;
      room.playlist.splice(index, 1);
      if (index < room.currentIndex) room.currentIndex -= 1;
      syncQueueFromPlaylist(room);
      touchRoom(room);
      return;
    }

    case "host": {
      if (clientId && room.participants.has(clientId)) {
        room.hostId = clientId;
        touchRoom(room);
      }
      return;
    }

    default: {
      const err = new Error(`Unknown command: ${command.type}`);
      err.status = 400;
      throw err;
    }
  }
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, { ok: true, uptime: process.uptime() });
    return true;
  }

  if (await handleAuth(req, res, url)) return true;
  if (!isAuthenticated(req)) {
    sendJson(res, { error: "Passcode required" }, 401);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/thumb") {
    const target = String(url.searchParams.get("url") || "");
    if (!/^https:\/\/(i\.ytimg\.com|img\.youtube\.com)\//.test(target)) {
      sendJson(res, { error: "Unsupported thumbnail host" }, 400);
      return true;
    }
    const upstream = await fetch(target);
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") || "image/jpeg",
      "Cache-Control": "public, max-age=86400"
    });
    const arrayBuffer = await upstream.arrayBuffer();
    res.end(Buffer.from(arrayBuffer));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/search") {
    const query = String(url.searchParams.get("q") || "").trim();
    if (query.length < 2) {
      sendJson(res, { items: [] });
      return true;
    }
    sendJson(res, await searchYouTube(query.slice(0, 120)));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/rooms") {
    const id = randomRoomId();
    getRoom(id);
    sendJson(res, { id });
    return true;
  }

  const roomMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)(?:\/([^/]+))?$/);
  if (!roomMatch) return false;

  const room = getRoom(roomMatch[1]);
  const action = roomMatch[2] || "";

  if (req.method === "GET" && !action) {
    sendJson(res, snapshot(room));
    return true;
  }

  if (req.method === "GET" && action === "events") {
    const clientId = String(url.searchParams.get("clientId") || randomUUID()).slice(0, 80);
    updateParticipant(room, clientId, {
      name: url.searchParams.get("name"),
      color: url.searchParams.get("color")
    });

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.write(`event: hello\ndata: ${JSON.stringify(snapshot(room))}\n\n`);
    room.clients.set(clientId, res);
    broadcast(room, "presence");

    const keepAlive = setInterval(() => {
      res.write(`event: ping\ndata: ${JSON.stringify({ serverTime: now() })}\n\n`);
    }, 25000);

    req.on("close", () => {
      clearInterval(keepAlive);
      room.clients.delete(clientId);
      const participant = room.participants.get(clientId);
      if (participant) {
        participant.lastSeenAt = now();
      }
      const hostChanged = clientId === room.hostId && promoteHost(room);
      broadcast(room, hostChanged ? "host" : "presence");
    });
    return true;
  }

  if (req.method === "POST" && action === "commands") {
    const command = await readBody(req);
    if (command.type === "enqueue" || command.type === "load") {
      const playlistId = extractPlaylistId(command.sourceUrl || command.url || "");
      if (playlistId) {
        const tracks = await fetchPlaylistTracks(playlistId);
        if (tracks.length === 0) {
          sendJson(res, { error: "Playlist had no playable items." }, 404);
          return true;
        }
        if (command.type === "load") {
          applyCommand(room, { ...command, type: "load", ...tracks[0] });
          for (const track of tracks.slice(1)) {
            applyCommand(room, { ...command, type: "enqueue", ...track });
          }
        } else {
          for (const track of tracks) {
            applyCommand(room, { ...command, type: "enqueue", ...track });
          }
        }
        broadcast(room, "state");
        sendJson(res, { ...snapshot(room), addedFromPlaylist: tracks.length });
        return true;
      }

      const spotifyRef = extractSpotifyRef(command.sourceUrl || command.url || "");
      if (spotifyRef) {
        const spotifyData = await fetchSpotifyTracks(command.sourceUrl || command.url);
        if (!spotifyData.tracks || spotifyData.tracks.length === 0) {
          sendJson(res, { error: "Spotify playlist had no playable tracks." }, 404);
          return true;
        }
        const { matched, unmatched } = await resolveSpotifyToYouTube(spotifyData.tracks);
        if (matched.length === 0) {
          sendJson(res, { error: "Could not match any Spotify tracks to YouTube videos." }, 404);
          return true;
        }
        if (command.type === "load") {
          applyCommand(room, { ...command, type: "load", ...matched[0] });
          for (const track of matched.slice(1)) {
            applyCommand(room, { ...command, type: "enqueue", ...track });
          }
        } else {
          for (const track of matched) {
            applyCommand(room, { ...command, type: "enqueue", ...track });
          }
        }
        broadcast(room, "state");
        sendJson(res, {
          ...snapshot(room),
          addedFromSpotify: matched.length,
          unmatched: unmatched.length,
          cappedAt: spotifyData.cappedAt || 0
        });
        return true;
      }
    }
    applyCommand(room, command);
    broadcast(room, command.type === "heartbeat" ? "sync" : command.type || "state");
    sendJson(res, snapshot(room));
    return true;
  }

  if (req.method === "POST" && action === "spotify-import") {
    const body = await readBody(req);
    const url = String(body.url || "").trim();
    if (!url) {
      sendJson(res, { error: "Missing url" }, 400);
      return true;
    }

    const spotifyRef = extractSpotifyRef(url);
    if (!spotifyRef) {
      sendJson(res, { error: "Invalid Spotify URL" }, 400);
      return true;
    }

    const spotifyData = await fetchSpotifyTracks(url);
    if (!spotifyData.tracks || spotifyData.tracks.length === 0) {
      sendJson(res, { error: "Spotify playlist had no playable tracks." }, 404);
      return true;
    }

    const jobId = randomUUID();
    const total = spotifyData.tracks.length;
    const clientId = String(body.clientId || "").slice(0, 80);
    const clientName = String(body.clientName || "Listener").slice(0, 80);
    const clientColor = String(body.clientColor || "").slice(0, 24);

    // Start async resolver (don't await)
    resolveSpotifyToYouTubeAsync(room, spotifyData.tracks, {
      jobId,
      clientId,
      clientName,
      clientColor,
      onProgress: (done, total, currentTitle, matchedCount, unmatchedCount) => {
        broadcastRaw(room, "import-progress", {
          jobId,
          done,
          total,
          currentTitle,
          matchedCount,
          unmatchedCount
        });
      },
      onComplete: (matchedCount, unmatchedCount, unmatched) => {
        broadcastRaw(room, "import-complete", {
          jobId,
          matchedCount,
          unmatchedCount,
          unmatched,
          cappedAt: spotifyData.cappedAt || 0
        });
      }
    });

    sendJson(res, {
      jobId,
      total,
      name: spotifyData.name,
      cover: spotifyData.cover,
      cappedAt: spotifyData.cappedAt || 0
    });
    return true;
  }

  return false;
}

function staticPath(pathname) {
  const cleanPath = decodeURIComponent(pathname).split("?")[0];
  const requested = cleanPath === "/" ? "/index.html" : cleanPath;
  const target = normalize(join(publicDir, requested));
  if (!target.startsWith(publicDir)) return null;
  return target;
}

async function handleStatic(req, res, url) {
  let target = staticPath(url.pathname);
  if (!target) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (!existsSync(target)) {
    target = join(publicDir, "index.html");
  }

  const ext = extname(target);
  const contentType = mimeTypes.get(ext) || "application/octet-stream";
  const headers = {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Cross-Origin-Opener-Policy": "same-origin-allow-popups"
  };

  res.writeHead(200, headers);
  createReadStream(target).pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname.startsWith("/api/")) {
      const handled = await handleApi(req, res, url);
      if (handled) return;
      sendJson(res, { error: "Not found" }, 404);
      return;
    }

    await handleStatic(req, res, url);
  } catch (error) {
    const status = error.status || 500;
    sendJson(res, { error: error.message || "Server error" }, status);
  }
});

server.listen(port, () => {
  console.log(`Listening on http://localhost:${port}`);
});
