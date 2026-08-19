import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const EXT = Object.freeze({
  NAME: "QuickModulePicker",
  ROOT_ID: "qmp-root",
  PANEL_ID: "qmp-panel",
  STORAGE_KEY: "qmp_items_v2",
  LEGACY_STORAGE_KEY: "qmp_modules_v1",
  HOTKEY_STORAGE: "qmp_hotkey_v2",
  SEEDED_FLAG: "qmp_seeded_from_base_v1",
  BASE_GET_URL: "/quickmodulepicker/base",
  BASE_SAVE_URL: "/quickmodulepicker/save_base",
  // Physical key below Esc / left of 1 (Backquote `). UK layout may also show ¬.
  DEFAULT_HOTKEY: "`",
  PANEL_WIDTH: 380,
  LIST_VISIBLE_ROWS: 6,
  LIST_ROW_HEIGHT: 36,
  LIST_ROW_GAP: 2,
  CLIPBOARD_KEY: "litegrapheditor_clipboard",
});

/** Pixel height for exactly LIST_VISIBLE_ROWS items (avoids fragile CSS calc/var). */
const LIST_MAX_HEIGHT_PX =
  EXT.LIST_VISIBLE_ROWS * EXT.LIST_ROW_HEIGHT +
  (EXT.LIST_VISIBLE_ROWS - 1) * EXT.LIST_ROW_GAP;

const DEFAULT_ITEMS = [
  { id: "n-ckpt", kind: "node", type: "CheckpointLoaderSimple", label: "Load Checkpoint" },
  { id: "n-clip", kind: "node", type: "CLIPTextEncode", label: "CLIP Text Encode" },
  { id: "n-ks", kind: "node", type: "KSampler", label: "KSampler" },
  { id: "n-vae", kind: "node", type: "VAEDecode", label: "VAE Decode" },
  { id: "n-empty", kind: "node", type: "EmptyLatentImage", label: "Empty Latent Image" },
  { id: "n-save", kind: "node", type: "SaveImage", label: "Save Image" },
  { id: "n-lora", kind: "node", type: "LoraLoader", label: "Load LoRA" },
  { id: "n-prev", kind: "node", type: "PreviewImage", label: "Preview Image" },
];

const state = {
  active: false,
  holding: false,
  pinned: false,
  root: null,
  panel: null,
  listEl: null,
  searchEl: null,
  hintEl: null,
  saveNameEl: null,
  actionsEl: null,
  helpEl: null,
  helpBtn: null,
  helpPop: null,
  titleRowEl: null,
  dragging: false,
  dragOffsetX: 0,
  dragOffsetY: 0,
  modalEl: null,
  modalTitleEl: null,
  modalMessageEl: null,
  modalOkBtn: null,
  modalCancelBtn: null,
  dialogOpen: false,
  dialogResolver: null,
  items: [],
  filtered: [],
  highlight: 0,
  selectedIds: new Set(),
  lastSelectIndex: 0,
  clickTimer: null,
  hovered: false,
  clientX: 0,
  clientY: 0,
  canvasX: 0,
  canvasY: 0,
  hotkey: EXT.DEFAULT_HOTKEY,
  basePath: "",
  ready: false,
};

function uid(prefix = "item") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== "object") return null;

  if (raw.kind === "snippet" && raw.data) {
    return {
      id: raw.id || uid("snip"),
      kind: "snippet",
      label: raw.label || "Snippet",
      type: raw.type || `Snippet (${raw.nodeCount || "?"} nodes)`,
      data: raw.data,
      nodeCount: raw.nodeCount || 0,
    };
  }

  if (typeof raw.type === "string" && raw.type) {
    return {
      id: raw.id || uid("node"),
      kind: "node",
      label: raw.label || raw.type,
      type: raw.type,
    };
  }

  return null;
}

function readLocalItems() {
  try {
    const raw = localStorage.getItem(EXT.STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map(normalizeItem).filter(Boolean);
      }
    }
  } catch (_) {}

  try {
    const legacy = localStorage.getItem(EXT.LEGACY_STORAGE_KEY);
    if (legacy) {
      const parsed = JSON.parse(legacy);
      if (Array.isArray(parsed) && parsed.length) {
        return parsed.map(normalizeItem).filter(Boolean);
      }
    }
  } catch (_) {}

  return null; // null = never initialized
}

function writeLocalItems(items) {
  try {
    localStorage.setItem(EXT.STORAGE_KEY, JSON.stringify(items));
    localStorage.setItem(EXT.SEEDED_FLAG, "1");
  } catch (err) {
    console.warn("[QuickModulePicker] Failed to save local items:", err);
    void qmpAlert(
      "Could not save locally. Snippet may be too large for browser storage.",
      "Quick Paste"
    );
  }
}

function closeDialog(result) {
  if (!state.dialogOpen) return;
  state.dialogOpen = false;
  if (state.modalEl) state.modalEl.classList.remove("is-open");
  const resolve = state.dialogResolver;
  state.dialogResolver = null;
  if (resolve) resolve(!!result);
}

function showDialog({
  title = "Quick Paste",
  message = "",
  confirmLabel = "OK",
  cancelLabel = "Cancel",
  showCancel = false,
} = {}) {
  ensureDom();
  return new Promise((resolve) => {
    if (state.dialogOpen) closeDialog(false);

    state.dialogOpen = true;
    state.dialogResolver = resolve;
    state.pinned = true;

    if (state.modalTitleEl) state.modalTitleEl.textContent = title;
    if (state.modalMessageEl) state.modalMessageEl.textContent = message;
    if (state.modalOkBtn) state.modalOkBtn.textContent = confirmLabel;
    if (state.modalCancelBtn) {
      state.modalCancelBtn.textContent = cancelLabel;
      state.modalCancelBtn.style.display = showCancel ? "" : "none";
    }
    if (state.modalEl) state.modalEl.classList.add("is-open");
    state.modalOkBtn?.focus?.({ preventScroll: true });
  });
}

function qmpAlert(message, title = "Quick Paste") {
  return showDialog({
    title,
    message,
    confirmLabel: "OK",
    showCancel: false,
  });
}

function qmpConfirm(message, title = "Confirm") {
  return showDialog({
    title,
    message,
    confirmLabel: "OK",
    cancelLabel: "Cancel",
    showCancel: true,
  });
}

async function apiRequest(path, options = {}) {
  if (typeof api?.fetchApi === "function") {
    return api.fetchApi(path, options);
  }
  return fetch(path, options);
}

async function fetchTeamBase() {
  const response = await apiRequest(EXT.BASE_GET_URL, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`GET ${EXT.BASE_GET_URL} failed (${response.status})`);
  }
  const payload = await response.json();
  state.basePath = payload.path || "";
  return Array.isArray(payload.items)
    ? payload.items.map(normalizeItem).filter(Boolean)
    : [];
}

async function publishTeamBase(items) {
  const response = await apiRequest(EXT.BASE_SAVE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });
  if (!response.ok) {
    const text = await response.text();
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      detail = parsed.error || text;
    } catch (_) {}
    throw new Error(detail || `HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!payload.ok) {
    throw new Error(payload.error || "Save failed");
  }
  state.basePath = payload.path || state.basePath;
  return payload;
}

function cloneItems(items) {
  return items.map((item) => ({
    ...item,
    id: item.id || uid(item.kind === "snippet" ? "snip" : "node"),
  }));
}

async function loadItems() {
  const local = readLocalItems();

  if (local != null && localStorage.getItem(EXT.SEEDED_FLAG) === "1") {
    state.items = local;
    state.ready = true;
    try {
      await fetchTeamBase();
    } catch (_) {}
    return state.items;
  }

  try {
    const baseItems = await fetchTeamBase();
    if (baseItems.length) {
      state.items = cloneItems(baseItems);
      writeLocalItems(state.items);
      console.info("[QuickModulePicker] Seeded personal list from team base");
    } else if (local != null && local.length) {
      state.items = local;
      writeLocalItems(state.items);
    } else {
      state.items = DEFAULT_ITEMS.map((item) => ({ ...item }));
      writeLocalItems(state.items);
    }
  } catch (err) {
    console.warn("[QuickModulePicker] Team base unavailable:", err);
    state.items =
      local != null && local.length
        ? local
        : DEFAULT_ITEMS.map((item) => ({ ...item }));
    writeLocalItems(state.items);
  }

  state.ready = true;
  return state.items;
}

function saveItems() {
  writeLocalItems(state.items);
}

async function resetToTeamBase() {
  keepPanelOpen();
  try {
    const baseItems = await fetchTeamBase();
    if (!baseItems.length) {
      await qmpAlert(
        "Default list is empty.\nAsk the maintainer to click “Publish as default” first.",
        "Back to default"
      );
      return;
    }
    const ok = await qmpConfirm(
      `Reset your Quick Paste list to the default?\n\nThis replaces your personal list with ${baseItems.length} shared item(s).`,
      "Back to default"
    );
    if (!ok) return;
    state.items = cloneItems(baseItems);
    writeLocalItems(state.items);
    applyFilter(state.searchEl?.value || "");
    renderList();
    updateHint();
  } catch (err) {
    await qmpAlert(
      "Could not load default list.\n" + String(err?.message || err),
      "Back to default"
    );
  }
}

async function publishAsTeamBase() {
  keepPanelOpen();
  if (!state.items.length) {
    await qmpAlert("Your list is empty. Nothing to publish.", "Publish as default");
    return;
  }
  const ok = await qmpConfirm(
    `Publish your current list as the default Quick Paste?\n\nThis updates snippets.base.json for everyone who resets/initializes (${state.items.length} item(s)).`,
    "Publish as default"
  );
  if (!ok) return;
  try {
    await publishTeamBase(state.items);
    await qmpAlert(
      "Default list published.\nOthers can use “Back to default” to get this version.",
      "Publish as default"
    );
    updateHint();
  } catch (err) {
    await qmpAlert(
      "Could not publish default list.\n\n" +
        "1) Copy the latest __init__.py into custom_nodes/ComfyUI-QuickModulePicker\n" +
        "2) Fully restart ComfyUI (not only refresh)\n" +
        "3) Confirm the shared folder is writable\n\n" +
        String(err?.message || err),
      "Publish as default"
    );
  }
}

function loadHotkey() {
  try {
    const stored =
      localStorage.getItem(EXT.HOTKEY_STORAGE) ||
      localStorage.getItem("qmp_hotkey_v1");
    return normalizeHotkey(stored);
  } catch (_) {
    return EXT.DEFAULT_HOTKEY;
  }
}

function normalizeHotkey(value) {
  const raw = String(value ?? "").trim();
  // Migrate previous default (middle dot) → Backquote key
  if (!raw || raw === "·") return EXT.DEFAULT_HOTKEY;
  if (raw === "Backquote") return "`";
  return raw;
}

function saveHotkey(key) {
  state.hotkey = normalizeHotkey(key);
  try {
    localStorage.setItem(EXT.HOTKEY_STORAGE, state.hotkey);
  } catch (_) {}
}

function shouldIgnoreKeyEvent(event) {
  const tag = String(event?.target?.tagName || "").toLowerCase();
  return (
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    !!event?.target?.isContentEditable
  );
}

function isBackquoteHotkey(hotkey) {
  return hotkey === "`" || hotkey === "Backquote" || hotkey === "·";
}

function isHotkeyEvent(event) {
  if (!event) return false;
  const want = state.hotkey;
  if (!want) return false;
  if (event.key === want || event.code === want) return true;
  // Match the physical key below Esc / left of 1 across layouts (US `, UK ¬/`)
  if (isBackquoteHotkey(want) && event.code === "Backquote") return true;
  return false;
}

function formatHotkeyLabel(hotkey) {
  if (isBackquoteHotkey(hotkey || EXT.DEFAULT_HOTKEY)) return "`";
  return hotkey || EXT.DEFAULT_HOTKEY;
}

function stripHotkeyChars(value) {
  let next = String(value || "");
  if (state.hotkey) next = next.split(state.hotkey).join("");
  return next;
}

function clientToCanvas(clientX, clientY) {
  const canvas = app?.canvas;
  if (!canvas) return [0, 0];

  if (typeof app.clientPosToCanvasPos === "function") {
    return app.clientPosToCanvasPos([clientX, clientY]);
  }

  const rect = canvas.canvas?.getBoundingClientRect?.() || { left: 0, top: 0 };
  const x = clientX - rect.left;
  const y = clientY - rect.top;

  if (typeof canvas.convertOffsetToCanvas === "function") {
    return canvas.convertOffsetToCanvas([x, y]);
  }

  const ds = canvas.ds || { scale: 1, offset: [0, 0] };
  return [(x - ds.offset[0]) / ds.scale, (y - ds.offset[1]) / ds.scale];
}

function getSelectedNodes() {
  const canvas = app?.canvas;
  if (!canvas) return [];

  if (canvas.selectedItems instanceof Set && canvas.selectedItems.size) {
    const nodes = [];
    for (const item of canvas.selectedItems) {
      if (item && typeof item === "object" && item.type && Array.isArray(item.pos)) {
        nodes.push(item);
      }
    }
    if (nodes.length) return nodes;
  }

  const map = canvas.selected_nodes || {};
  const fromMap = Object.values(map).filter(Boolean);
  if (fromMap.length) return fromMap;

  if (canvas.selected_node) return [canvas.selected_node];
  if (canvas.current_node) return [canvas.current_node];
  return [];
}

function serializeSelection(nodes) {
  const graph = app?.graph;
  if (!graph || !nodes?.length) return null;

  const selectedIds = new Set(nodes.map((n) => n.id));
  const indexById = new Map();
  const serializedNodes = [];

  nodes.forEach((node, index) => {
    indexById.set(node.id, index);
    const cloned = typeof node.clone === "function" ? node.clone() : null;
    const data = cloned?.serialize?.() || node.serialize?.();
    if (!data) return;

    if (Array.isArray(data.inputs)) {
      for (const input of data.inputs) {
        if (input) input.link = null;
      }
    }
    if (Array.isArray(data.outputs)) {
      for (const output of data.outputs) {
        if (output) output.links = [];
      }
    }
    delete data.id;
    serializedNodes.push(data);
  });

  if (!serializedNodes.length) return null;

  const links = [];
  for (const node of nodes) {
    if (!node.inputs?.length) continue;
    for (let slot = 0; slot < node.inputs.length; slot++) {
      const input = node.inputs[slot];
      if (!input || input.link == null) continue;
      const linkInfo = graph.links?.[input.link];
      if (!linkInfo) continue;

      const originId = linkInfo.origin_id ?? linkInfo[1];
      const originSlot = linkInfo.origin_slot ?? linkInfo[2];
      const targetSlot = linkInfo.target_slot ?? linkInfo[4] ?? slot;

      if (!selectedIds.has(originId)) continue;
      const relativeOrigin = indexById.get(originId);
      const relativeTarget = indexById.get(node.id);
      if (relativeOrigin == null || relativeTarget == null) continue;

      links.push([relativeOrigin, originSlot, relativeTarget, targetSlot]);
    }
  }

  return {
    nodes: serializedNodes,
    links,
  };
}

function captureSelectionClipboard() {
  const nodes = getSelectedNodes();
  if (!nodes.length) return null;

  const canvas = app.canvas;
  const previous = localStorage.getItem(EXT.CLIPBOARD_KEY);

  try {
    if (typeof canvas.copyToClipboard === "function") {
      canvas.copyToClipboard();
      const copied = localStorage.getItem(EXT.CLIPBOARD_KEY);
      if (copied) {
        const parsed = JSON.parse(copied);
        if (parsed?.nodes?.length) {
          return {
            data: copied,
            nodeCount: parsed.nodes.length,
            nodes,
          };
        }
      }
    }
  } catch (err) {
    console.warn("[QuickModulePicker] copyToClipboard failed, using fallback:", err);
  }

  const fallback = serializeSelection(nodes);
  if (!fallback) return null;

  if (previous != null) {
    try {
      localStorage.setItem(EXT.CLIPBOARD_KEY, previous);
    } catch (_) {}
  }

  return {
    data: JSON.stringify(fallback),
    nodeCount: fallback.nodes.length,
    nodes,
  };
}

function pasteSnippetAtCursor(dataString) {
  const canvas = app?.canvas;
  const graph = app?.graph;
  if (!canvas || !graph || !dataString) return false;

  if (Array.isArray(canvas.graph_mouse)) {
    canvas.graph_mouse[0] = state.canvasX;
    canvas.graph_mouse[1] = state.canvasY;
  } else {
    canvas.graph_mouse = [state.canvasX, state.canvasY];
  }

  try {
    localStorage.setItem(EXT.CLIPBOARD_KEY, dataString);
  } catch (err) {
    console.warn("[QuickModulePicker] clipboard write failed:", err);
  }

  try {
    if (typeof canvas.pasteFromClipboard === "function") {
      canvas.pasteFromClipboard();
      return true;
    }
  } catch (err) {
    console.warn("[QuickModulePicker] pasteFromClipboard failed:", err);
  }

  try {
    const deserialised = JSON.parse(dataString);
    if (!deserialised?.nodes?.length) return false;

    const topLeft = [Infinity, Infinity];
    for (const { pos } of deserialised.nodes) {
      if (!pos) continue;
      if (topLeft[0] > pos[0]) topLeft[0] = pos[0];
      if (topLeft[1] > pos[1]) topLeft[1] = pos[1];
    }
    if (!Number.isFinite(topLeft[0]) || !Number.isFinite(topLeft[1])) {
      topLeft[0] = state.canvasX;
      topLeft[1] = state.canvasY;
    }

    graph.beforeChange?.();
    const created = [];
    for (const info of deserialised.nodes) {
      const node = LiteGraph.createNode(info.type);
      if (!node) continue;
      node.configure(info);
      node.pos[0] += state.canvasX - topLeft[0];
      node.pos[1] += state.canvasY - topLeft[1];
      graph.add(node);
      created.push(node);
    }

    for (const info of deserialised.links || []) {
      const outNode = created[info[0]];
      const inNode = created[info[2]];
      if (outNode && inNode) outNode.connect(info[1], inNode, info[3]);
    }

    if (created.length) {
      if (typeof canvas.selectNodes === "function") canvas.selectNodes(created);
      else if (typeof canvas.selectNode === "function") canvas.selectNode(created[0], false);
    }

    graph.afterChange?.();
    graph.setDirtyCanvas?.(true, true);
    canvas.setDirty?.(true, true);
    return created.length > 0;
  } catch (err) {
    console.warn("[QuickModulePicker] manual paste failed:", err);
    return false;
  }
}

function itemMeta(item) {
  if (item.kind === "snippet") {
    const count = item.nodeCount || 0;
    return count ? `${count} nodes` : "snippet";
  }
  return item.type || "node";
}

function ensureDom() {
  if (state.root) return;

  const root = document.createElement("div");
  root.id = EXT.ROOT_ID;
  root.innerHTML = `
    <style>
      #${EXT.ROOT_ID} {
        position: fixed;
        inset: 0;
        pointer-events: none;
        z-index: 100000;
        font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      }
      #${EXT.PANEL_ID} {
        position: fixed;
        display: none;
        width: ${EXT.PANEL_WIDTH}px;
        max-height: min(560px, calc(100vh - 24px));
        padding: 14px;
        border-radius: 14px;
        background: rgba(22, 24, 28, 0.96);
        border: 1px solid rgba(255, 255, 255, 0.12);
        box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45);
        backdrop-filter: blur(12px);
        color: #f2f4f8;
        pointer-events: auto;
        overflow: visible;
      }
      .qmp-title-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 10px;
        cursor: grab;
        user-select: none;
      }
      .qmp-title-row.is-dragging {
        cursor: grabbing;
      }
      .qmp-title {
        font-size: 14px;
        font-weight: 600;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: rgba(242, 244, 248, 0.7);
        margin: 0;
        flex: 1;
      }
      .qmp-help {
        position: relative;
        flex: 0 0 auto;
      }
      .qmp-help-btn {
        width: 22px;
        height: 22px;
        border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, 0.22);
        background: rgba(255, 255, 255, 0.06);
        color: rgba(242, 244, 248, 0.75);
        font-size: 13px;
        font-weight: 700;
        line-height: 1;
        cursor: pointer;
        display: grid;
        place-items: center;
        padding: 0;
      }
      .qmp-help-btn:hover,
      .qmp-help.is-open .qmp-help-btn {
        background: rgba(120, 180, 255, 0.22);
        border-color: rgba(120, 180, 255, 0.45);
        color: #fff;
      }
      .qmp-help-pop {
        display: none;
        position: absolute;
        top: calc(100% + 8px);
        right: 0;
        width: 280px;
        z-index: 5;
        padding: 12px;
        border-radius: 10px;
        background: rgba(24, 26, 32, 0.98);
        border: 1px solid rgba(255, 255, 255, 0.14);
        box-shadow: 0 12px 28px rgba(0, 0, 0, 0.45);
        color: rgba(242, 244, 248, 0.9);
        font-size: 12px;
        line-height: 1.45;
        pointer-events: auto;
        cursor: default;
        user-select: text;
      }
      .qmp-help.is-open .qmp-help-pop {
        display: block;
      }
      .qmp-help-pop strong {
        display: block;
        font-size: 13px;
        margin-bottom: 8px;
        color: #fff;
      }
      .qmp-help-pop ul {
        margin: 0;
        padding-left: 16px;
      }
      .qmp-help-pop li {
        margin: 4px 0;
      }
      .qmp-help-pop code {
        font-family: Consolas, "Courier New", monospace;
        font-size: 11px;
        padding: 1px 5px;
        border-radius: 4px;
        background: rgba(255, 255, 255, 0.08);
      }
      .qmp-save-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 10px;
      }
      .qmp-save-name {
        flex: 1;
        min-width: 0;
        box-sizing: border-box;
        padding: 9px 11px;
        border-radius: 10px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(255, 255, 255, 0.06);
        color: #f2f4f8;
        outline: none;
        font-size: 14px;
      }
      .qmp-save-name:focus {
        border-color: rgba(120, 180, 255, 0.55);
      }
      .qmp-save-row .qmp-action {
        flex: 0 0 auto;
        white-space: nowrap;
      }
      .qmp-filter-box {
        margin-bottom: 10px;
        padding: 10px;
        border-radius: 12px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(255, 255, 255, 0.03);
      }
      .qmp-search-wrap {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
        padding: 7px 10px;
        border-radius: 10px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(255, 255, 255, 0.06);
      }
      .qmp-search-wrap:focus-within {
        border-color: rgba(120, 180, 255, 0.55);
      }
      .qmp-search-icon {
        flex: 0 0 auto;
        width: 14px;
        height: 14px;
        color: rgba(242, 244, 248, 0.45);
        display: block;
      }
      .qmp-search {
        flex: 1;
        min-width: 0;
        box-sizing: border-box;
        padding: 0;
        border: none;
        background: transparent;
        color: #f2f4f8;
        outline: none;
        font-size: 14px;
      }
      .qmp-list {
        display: flex;
        flex-direction: column;
        gap: ${EXT.LIST_ROW_GAP}px;
        height: auto;
        max-height: ${LIST_MAX_HEIGHT_PX}px;
        overflow-x: hidden;
        overflow-y: auto;
        overscroll-behavior: contain;
        scrollbar-gutter: stable;
      }
      .qmp-item {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        flex: 0 0 ${EXT.LIST_ROW_HEIGHT}px;
        height: ${EXT.LIST_ROW_HEIGHT}px;
        min-height: ${EXT.LIST_ROW_HEIGHT}px;
        max-height: ${EXT.LIST_ROW_HEIGHT}px;
        box-sizing: border-box;
        text-align: left;
        padding: 0 10px;
        border: none;
        border-radius: 8px;
        background: transparent;
        color: inherit;
        cursor: pointer;
        font-size: 13px;
        overflow: hidden;
      }
      .qmp-item:hover,
      .qmp-item.is-active {
        background: rgba(120, 180, 255, 0.18);
      }
      .qmp-item.is-selected {
        background: rgba(120, 180, 255, 0.28);
        box-shadow: inset 0 0 0 1px rgba(120, 180, 255, 0.35);
      }
      .qmp-item.is-selected.is-active {
        background: rgba(120, 180, 255, 0.34);
      }
      .qmp-index {
        width: 18px;
        flex: 0 0 18px;
        font-size: 11px;
        color: rgba(242, 244, 248, 0.45);
        font-variant-numeric: tabular-nums;
      }
      .qmp-label {
        flex: 1;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-size: 13px;
        font-weight: 600;
      }
      .qmp-type {
        font-size: 10px;
        color: rgba(242, 244, 248, 0.5);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 38%;
      }
      .qmp-badge {
        flex: 0 0 auto;
        font-size: 9px;
        padding: 1px 5px;
        border-radius: 999px;
        background: rgba(120, 180, 255, 0.18);
        color: rgba(180, 210, 255, 0.95);
      }
      .qmp-empty {
        padding: 18px 10px;
        text-align: center;
        color: rgba(242, 244, 248, 0.45);
        font-size: 13px;
      }
      .qmp-hint {
        margin-top: 10px;
        font-size: 12px;
        color: rgba(242, 244, 248, 0.55);
        line-height: 1.45;
      }
      .qmp-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .qmp-actions .qmp-action {
        flex: 1 1 calc(50% - 4px);
        min-width: 140px;
      }
      .qmp-actions .qmp-action[data-action="delete"] {
        flex: 1 1 100%;
      }
      .qmp-action {
        padding: 9px 10px;
        border-radius: 10px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(255, 255, 255, 0.04);
        color: rgba(242, 244, 248, 0.9);
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
      }
      .qmp-action:hover {
        background: rgba(255, 255, 255, 0.1);
      }
      .qmp-action.is-danger:hover {
        background: rgba(220, 80, 80, 0.25);
        border-color: rgba(220, 80, 80, 0.45);
      }
      .qmp-action.is-primary {
        background: rgba(120, 180, 255, 0.22);
        border-color: rgba(120, 180, 255, 0.35);
      }
      .qmp-remove {
        flex: 0 0 auto;
        width: 22px;
        height: 22px;
        margin-left: 2px;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: rgba(242, 244, 248, 0.5);
        cursor: pointer;
        font-size: 14px;
        line-height: 1;
        display: grid;
        place-items: center;
      }
      .qmp-remove:hover {
        background: rgba(220, 80, 80, 0.25);
        color: #ffb4b4;
      }
      .qmp-modal {
        position: fixed;
        inset: 0;
        display: none;
        align-items: center;
        justify-content: center;
        z-index: 100001;
        pointer-events: auto;
        background: rgba(0, 0, 0, 0.55);
        padding: 24px;
      }
      .qmp-modal.is-open {
        display: flex;
      }
      .qmp-modal__card {
        width: min(420px, 100%);
        padding: 18px;
        border-radius: 14px;
        background: rgba(28, 30, 36, 0.98);
        border: 1px solid rgba(255, 255, 255, 0.14);
        box-shadow: 0 18px 48px rgba(0, 0, 0, 0.55);
        color: #f2f4f8;
      }
      .qmp-modal__title {
        font-size: 15px;
        font-weight: 700;
        margin-bottom: 10px;
      }
      .qmp-modal__message {
        font-size: 14px;
        line-height: 1.45;
        color: rgba(242, 244, 248, 0.88);
        white-space: pre-wrap;
        margin-bottom: 16px;
      }
      .qmp-modal__actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }
      .qmp-modal__btn {
        min-width: 88px;
        padding: 9px 14px;
        border-radius: 10px;
        border: 1px solid rgba(255, 255, 255, 0.14);
        background: rgba(255, 255, 255, 0.06);
        color: #f2f4f8;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
      }
      .qmp-modal__btn:hover {
        background: rgba(255, 255, 255, 0.12);
      }
      .qmp-modal__btn.is-primary {
        background: rgba(120, 180, 255, 0.28);
        border-color: rgba(120, 180, 255, 0.45);
      }
    </style>
    <div id="${EXT.PANEL_ID}">
      <div class="qmp-title-row">
        <div class="qmp-title">Quick Paste</div>
        <div class="qmp-help">
          <button type="button" class="qmp-help-btn" aria-label="Help" title="Help">?</button>
          <div class="qmp-help-pop" role="tooltip"></div>
        </div>
      </div>
      <div class="qmp-save-row">
        <input class="qmp-save-name" type="text" placeholder="Save Name..." autocomplete="off" spellcheck="false" />
        <button type="button" class="qmp-action is-primary" data-action="save" title="Save currently selected nodes as a reusable snippet">Save selection</button>
      </div>
      <div class="qmp-filter-box">
        <div class="qmp-search-wrap">
          <svg class="qmp-search-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/>
            <path d="M16.5 16.5L21 21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          <input class="qmp-search" type="text" placeholder="Filter list..." autocomplete="off" spellcheck="false" />
        </div>
        <div class="qmp-list"></div>
      </div>
      <div class="qmp-actions">
        <button type="button" class="qmp-action" data-action="publish-base" title="Save your current list as the shared default">Publish as default</button>
        <button type="button" class="qmp-action" data-action="reset-base" title="Replace your personal list with the shared default">Back to default</button>
        <button type="button" class="qmp-action is-danger" data-action="delete">Delete</button>
      </div>
      <div class="qmp-hint"></div>
    </div>
    <div class="qmp-modal" role="dialog" aria-modal="true">
      <div class="qmp-modal__card">
        <div class="qmp-modal__title"></div>
        <div class="qmp-modal__message"></div>
        <div class="qmp-modal__actions">
          <button type="button" class="qmp-modal__btn" data-modal="cancel">Cancel</button>
          <button type="button" class="qmp-modal__btn is-primary" data-modal="ok">OK</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(root);
  state.root = root;
  state.panel = root.querySelector(`#${EXT.PANEL_ID}`);
  state.listEl = root.querySelector(".qmp-list");
  state.searchEl = root.querySelector(".qmp-search");
  state.hintEl = root.querySelector(".qmp-hint");
  state.saveNameEl = root.querySelector(".qmp-save-name");
  state.actionsEl = root.querySelector(".qmp-actions");
  state.helpEl = root.querySelector(".qmp-help");
  state.helpBtn = root.querySelector(".qmp-help-btn");
  state.helpPop = root.querySelector(".qmp-help-pop");
  state.titleRowEl = root.querySelector(".qmp-title-row");
  state.modalEl = root.querySelector(".qmp-modal");
  state.modalTitleEl = root.querySelector(".qmp-modal__title");
  state.modalMessageEl = root.querySelector(".qmp-modal__message");
  state.modalOkBtn = root.querySelector('[data-modal="ok"]');
  state.modalCancelBtn = root.querySelector('[data-modal="cancel"]');

  refreshHelpContent();

  state.panel.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    state.pinned = true;
    state.holding = false;
    state.hovered = false;
  });

  state.helpBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    keepPanelOpen();
    refreshHelpContent();
    state.helpEl.classList.toggle("is-open");
  });

  // Click elsewhere inside the panel closes the pinned help popover
  state.panel.addEventListener("click", (event) => {
    if (!state.helpEl?.classList.contains("is-open")) return;
    if (state.helpEl.contains(event.target)) return;
    state.helpEl.classList.remove("is-open");
  });

  // Drag panel by the title row (not the help button)
  state.titleRowEl.addEventListener("pointerdown", (event) => {
    if (event.button != null && event.button !== 0) return;
    if (event.target?.closest?.(".qmp-help")) return;
    event.preventDefault();
    event.stopPropagation();
    beginPanelDrag(event);
  });

  window.addEventListener("pointermove", onPanelDragMove, { passive: false });
  window.addEventListener("pointerup", onPanelDragEnd, { capture: true });
  window.addEventListener("pointercancel", onPanelDragEnd, { capture: true });

  state.modalEl.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });

  state.modalOkBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    closeDialog(true);
  });

  state.modalCancelBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    closeDialog(false);
  });

  state.listEl.addEventListener("mouseleave", () => {
    state.hovered = false;
  });

  state.searchEl.addEventListener("input", () => {
    applyFilter(state.searchEl.value);
    renderList();
  });

  state.searchEl.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveHighlight(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveHighlight(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      pickHighlighted();
    } else if (event.key === "Delete" || event.key === "Backspace") {
      if (!state.searchEl.value) {
        event.preventDefault();
        deleteHighlightedItem();
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      hidePanel();
    }
  });

  state.saveNameEl.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      void saveSelectionFromName();
    } else if (event.key === "Escape") {
      event.preventDefault();
      hidePanel();
    }
  });

  state.saveNameEl.addEventListener("input", () => {
    const cleaned = stripHotkeyChars(state.saveNameEl.value);
    if (cleaned !== state.saveNameEl.value) {
      state.saveNameEl.value = cleaned;
    }
  });

  root.querySelector('[data-action="save"]').addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    keepPanelOpen();
    void saveSelectionFromName();
  });

  root.querySelector('[data-action="delete"]').addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    keepPanelOpen();
    deleteHighlightedItem();
  });

  root.querySelector('[data-action="reset-base"]').addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void resetToTeamBase();
  });

  root.querySelector('[data-action="publish-base"]').addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void publishAsTeamBase();
  });
}

function keepPanelOpen() {
  state.pinned = true;
  state.holding = false;
  state.hovered = false;
}

function setHighlight(index, { hovered = true, scroll = false } = {}) {
  if (!state.filtered.length) {
    state.highlight = 0;
    state.hovered = false;
    return;
  }
  const next = Math.max(0, Math.min(index, state.filtered.length - 1));
  state.highlight = next;
  state.hovered = hovered;
  syncListSelectionClasses();
  if (scroll) {
    const rows = state.listEl?.querySelectorAll(".qmp-item");
    rows?.[next]?.scrollIntoView?.({ block: "nearest" });
  }
}

function itemMatchesFilter(item, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;

  const label = String(item.label || "").toLowerCase();
  const type = String(item.type || "").toLowerCase();
  const kind = String(item.kind || "").toLowerCase();

  // Name / type contains query
  if (label.includes(q) || type.includes(q) || kind.includes(q)) return true;

  // First letter / prefix of the whole name
  if (label.startsWith(q) || type.startsWith(q)) return true;

  // First letter / prefix of any word (e.g. "e" → "EXR in-out", "s" → "Load SAM3 Model")
  const parts = label.split(/[\s_\-+./\\]+/).filter(Boolean);
  return parts.some((part) => part.startsWith(q));
}

function applyFilter(query, { resetHighlight = true } = {}) {
  const q = String(query || "").trim();
  state.filtered = q
    ? state.items.filter((item) => itemMatchesFilter(item, q))
    : state.items.slice();

  if (resetHighlight) {
    state.highlight = 0;
  } else if (state.highlight >= state.filtered.length) {
    state.highlight = Math.max(0, state.filtered.length - 1);
  }
}

function moveHighlight(delta) {
  if (!state.filtered.length) return;
  const next = (state.highlight + delta + state.filtered.length) % state.filtered.length;
  setHighlight(next, { hovered: true, scroll: true });
}

function renderList() {
  if (!state.listEl) return;
  state.listEl.innerHTML = "";

  if (!state.filtered.length) {
    const empty = document.createElement("div");
    empty.className = "qmp-empty";
    empty.textContent = state.searchEl?.value?.trim()
      ? "No matching items."
      : "No items yet. Select nodes, enter a Save Name, then Save selection.";
    state.listEl.appendChild(empty);
    return;
  }

  // Render all matches; CSS limits visible rows to 6 and enables wheel scroll
  state.filtered.forEach((item, index) => {
    const row = document.createElement("div");
    const selected = item.id && state.selectedIds.has(item.id);
    row.className =
      "qmp-item" +
      (index === state.highlight ? " is-active" : "") +
      (selected ? " is-selected" : "");
    row.dataset.index = String(index);
    row.innerHTML = `
      <span class="qmp-index">${index < 9 ? index + 1 : ""}</span>
      <span class="qmp-label"></span>
      <span class="qmp-type"></span>
      ${item.kind === "snippet" ? '<span class="qmp-badge">snip</span>' : ""}
      <button type="button" class="qmp-remove" title="Remove from list" aria-label="Remove">×</button>
    `;
    row.querySelector(".qmp-label").textContent = item.label;
    row.querySelector(".qmp-type").textContent = itemMeta(item);

    row.addEventListener("pointerenter", () => {
      setHighlight(index, { hovered: true });
    });

    // Single click = paste; Shift+click = multi-select; double click = replace
    row.addEventListener("click", (event) => {
      if (event.target?.closest?.(".qmp-remove")) return;
      if (event.button != null && event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();

      if (event.shiftKey) {
        clearTimeout(state.clickTimer);
        state.clickTimer = null;
        selectRangeTo(index);
        return;
      }

      // Normal click: select only this item, then paste after short delay
      state.selectedIds = new Set(item.id ? [item.id] : []);
      state.lastSelectIndex = index;
      state.highlight = index;
      syncListSelectionClasses();

      clearTimeout(state.clickTimer);
      state.clickTimer = setTimeout(() => {
        state.clickTimer = null;
        insertItem(item);
      }, 280);
    });

    row.addEventListener("dblclick", (event) => {
      if (event.target?.closest?.(".qmp-remove")) return;
      if (event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      clearTimeout(state.clickTimer);
      state.clickTimer = null;
      void replaceSnippetByItem(item);
    });

    row.querySelector(".qmp-remove").addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      keepPanelOpen();
      setHighlight(index, { hovered: false });
      state.selectedIds = new Set(item.id ? [item.id] : []);
      state.lastSelectIndex = index;
      void deleteSelectedItems();
    });

    state.listEl.appendChild(row);
  });
}

function beginPanelDrag(event) {
  if (!state.panel) return;
  keepPanelOpen();
  const rect = state.panel.getBoundingClientRect();
  state.dragging = true;
  state.dragOffsetX = event.clientX - rect.left;
  state.dragOffsetY = event.clientY - rect.top;
  state.titleRowEl?.classList.add("is-dragging");
  state.titleRowEl?.setPointerCapture?.(event.pointerId);
}

function onPanelDragMove(event) {
  if (!state.dragging || !state.panel) return;
  event.preventDefault();

  const width = state.panel.offsetWidth || EXT.PANEL_WIDTH;
  const height = state.panel.offsetHeight || 320;
  let left = event.clientX - state.dragOffsetX;
  let top = event.clientY - state.dragOffsetY;

  left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
  top = Math.max(8, Math.min(top, window.innerHeight - height - 8));

  state.panel.style.left = `${left}px`;
  state.panel.style.top = `${top}px`;
}

function onPanelDragEnd() {
  if (!state.dragging) return;
  state.dragging = false;
  state.titleRowEl?.classList.remove("is-dragging");
}

function positionPanel(clientX, clientY) {
  const width = EXT.PANEL_WIDTH;
  const height = state.panel?.offsetHeight || 320;
  let left = clientX + 12;
  let top = clientY + 12;

  if (left + width > window.innerWidth - 8) {
    left = Math.max(8, clientX - width - 12);
  }
  if (top + height > window.innerHeight - 8) {
    top = Math.max(8, window.innerHeight - height - 8);
  }

  state.panel.style.left = `${left}px`;
  state.panel.style.top = `${top}px`;
}

function syncListSelectionClasses() {
  if (!state.listEl) return;
  const rows = state.listEl.querySelectorAll(".qmp-item");
  rows.forEach((row, i) => {
    const item = state.filtered[i];
    row.classList.toggle("is-active", i === state.highlight);
    row.classList.toggle("is-selected", !!(item?.id && state.selectedIds.has(item.id)));
  });
}

function selectRangeTo(index) {
  if (!state.filtered.length) return;
  const end = Math.max(0, Math.min(index, state.filtered.length - 1));

  // First Shift+click with nothing selected: select only this item as the anchor
  if (!state.selectedIds.size) {
    const item = state.filtered[end];
    state.selectedIds = new Set(item?.id ? [item.id] : []);
    state.lastSelectIndex = end;
    state.highlight = end;
    state.hovered = false;
    syncListSelectionClasses();
    return;
  }

  const start = Math.max(0, Math.min(state.lastSelectIndex, state.filtered.length - 1));
  const a = Math.min(start, end);
  const b = Math.max(start, end);

  state.selectedIds = new Set();
  for (let i = a; i <= b; i++) {
    const item = state.filtered[i];
    if (item?.id) state.selectedIds.add(item.id);
  }
  state.highlight = end;
  state.hovered = false;
  syncListSelectionClasses();
}

function refreshHelpContent() {
  if (!state.helpPop) return;
  const key = formatHotkeyLabel(state.hotkey || EXT.DEFAULT_HOTKEY);
  state.helpPop.innerHTML = `
    <strong>Quick Paste shortcuts</strong>
    <ul>
      <li>Hold <code>${escapeHtml(key)}</code> (key left of <code>1</code>) to open the panel</li>
      <li>Click inside to keep it open; click outside to close</li>
      <li>Drag the title bar to move the panel</li>
      <li>Click <code>?</code> to open/close this help</li>
      <li><code>Save Name</code> + <code>Save selection</code> saves selected nodes</li>
      <li>Same Save Name asks to replace an existing snippet</li>
      <li><code>Filter list</code>: type a name or first letters to find items</li>
      <li>List shows 6 rows; scroll for more</li>
      <li>Click an item to paste it</li>
      <li>Double-click an item to replace it with the current selection</li>
      <li><code>Shift</code> + click to multi-select</li>
      <li><code>Delete</code> removes all selected items</li>
      <li><code>1</code>–<code>9</code> / <code>Enter</code> also paste the highlighted item</li>
      <li><code>Publish as default</code> saves the shared default list</li>
      <li><code>Back to default</code> restores the shared default list</li>
    </ul>
  `;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function updateHint() {
  if (!state.hintEl) return;
  const key = formatHotkeyLabel(state.hotkey || EXT.DEFAULT_HOTKEY);
  state.hintEl.textContent =
    `Hold ${key} · Drag title to move · Click ? for help · Outside closes`;
  refreshHelpContent();
}

async function deleteSelectedItems() {
  keepPanelOpen();

  let ids = [...state.selectedIds];
  if (!ids.length) {
    const highlighted = state.filtered[state.highlight];
    if (highlighted?.id) ids = [highlighted.id];
  }
  if (!ids.length) {
    await qmpAlert("Nothing selected to delete.", "Delete");
    return;
  }

  const labels = state.items
    .filter((item) => ids.includes(item.id))
    .map((item) => item.label);
  const preview =
    labels.length <= 3
      ? labels.map((n) => `“${n}”`).join(", ")
      : `${labels
          .slice(0, 2)
          .map((n) => `“${n}”`)
          .join(", ")} and ${labels.length - 2} more`;

  const ok = await qmpConfirm(
    `Delete ${ids.length} selected item(s)?\n\n${preview}`,
    "Delete"
  );
  if (!ok) return;

  state.items = state.items.filter((item) => !ids.includes(item.id));
  state.selectedIds = new Set();
  saveItems();
  applyFilter(state.searchEl?.value || "", { resetHighlight: false });
  if (state.highlight >= state.filtered.length) {
    state.highlight = Math.max(0, state.filtered.length - 1);
  }
  state.lastSelectIndex = state.highlight;
  state.hovered = false;
  renderList();
  updateHint();
}

function deleteHighlightedItem() {
  void deleteSelectedItems();
}

async function showPanel() {
  ensureDom();
  const local = readLocalItems();
  if (local != null && localStorage.getItem(EXT.SEEDED_FLAG) === "1") {
    state.items = local;
  } else {
    await loadItems();
  }
  applyFilter("");
  state.hovered = false;
  state.pinned = false;
  state.selectedIds = new Set();
  state.lastSelectIndex = 0;
  if (state.searchEl) state.searchEl.value = "";
  if (state.saveNameEl) state.saveNameEl.value = "";
  updateHint();
  state.panel.style.display = "block";
  positionPanel(state.clientX, state.clientY);
  renderList();
  state.active = true;
}

function hidePanel() {
  if (state.dialogOpen) closeDialog(false);
  state.active = false;
  state.holding = false;
  state.pinned = false;
  state.hovered = false;
  state.selectedIds = new Set();
  state.dragging = false;
  if (state.helpEl) state.helpEl.classList.remove("is-open");
  state.titleRowEl?.classList.remove("is-dragging");
  if (state.panel) state.panel.style.display = "none";
}

function spawnNode(type) {
  if (!type) return;

  let node = null;
  try {
    node = LiteGraph.createNode(type);
  } catch (err) {
    console.warn("[QuickModulePicker] createNode failed:", type, err);
  }

  if (!node) {
    void qmpAlert(`Node type not found: ${type}`, "Quick Paste");
    return;
  }

  node.pos = [state.canvasX, state.canvasY];
  app.graph.add(node);
  app.canvas?.selectNode?.(node, false);
  app.graph?.setDirtyCanvas?.(true, true);
  app.canvas?.setDirty?.(true, true);
  hidePanel();
}

function insertItem(item) {
  if (!item) return;

  if (item.kind === "snippet") {
    const ok = pasteSnippetAtCursor(item.data);
    if (!ok) {
      void qmpAlert(
        "Failed to paste snippet. The saved nodes may be unavailable in this ComfyUI.",
        "Quick Paste"
      );
      return;
    }
    hidePanel();
    return;
  }

  spawnNode(item.type);
}

function pickHighlighted() {
  // Keyboard / hover-release always paste; only a direct list click may replace
  const item = state.filtered[state.highlight];
  if (item) insertItem(item);
}

function findSnippetByLabel(label) {
  const target = String(label || "").trim().toLowerCase();
  if (!target) return -1;
  return state.items.findIndex(
    (item) => item.kind === "snippet" && String(item.label || "").trim().toLowerCase() === target
  );
}

async function replaceSnippetByItem(item) {
  keepPanelOpen();

  if (!item || item.kind !== "snippet") {
    await qmpAlert("Only snippet items can be replaced.", "Replace snippet");
    return;
  }

  const captured = captureSelectionClipboard();
  if (!captured) {
    await qmpAlert(
      "Select one or more nodes on the canvas first, then double-click a saved snippet to replace it.",
      "Replace snippet"
    );
    return;
  }

  const index = state.items.findIndex((entry) => entry.id === item.id);
  const fallbackIndex = index >= 0 ? index : findSnippetByLabel(item.label);
  if (fallbackIndex < 0) {
    await qmpAlert("Could not find that snippet in your list.", "Replace snippet");
    return;
  }

  const existing = state.items[fallbackIndex];
  const ok = await qmpConfirm(
    `Replace “${existing.label}” with the current selection (${captured.nodeCount} node(s))?\n\nThis cannot be undone.`,
    "Replace snippet"
  );
  if (!ok) return;

  state.items[fallbackIndex] = {
    ...existing,
    kind: "snippet",
    label: existing.label,
    type: `Snippet (${captured.nodeCount} nodes)`,
    data: captured.data,
    nodeCount: captured.nodeCount,
  };

  saveItems();
  applyFilter(state.searchEl?.value || "", { resetHighlight: false });
  renderList();
  updateHint();
}

async function saveSelectionFromName() {
  keepPanelOpen();

  let trimmed = stripHotkeyChars(state.saveNameEl?.value || "").trim();
  if (!trimmed) {
    await qmpAlert("Please enter a name in the Save Name field.", "Save selection");
    state.saveNameEl?.focus?.({ preventScroll: true });
    return;
  }

  const captured = captureSelectionClipboard();
  if (!captured) {
    await qmpAlert(
      "Select one or more nodes on the canvas first, then click Save selection.",
      "Save selection"
    );
    return;
  }

  const existingIndex = findSnippetByLabel(trimmed);
  if (existingIndex >= 0) {
    const existing = state.items[existingIndex];
    const ok = await qmpConfirm(
      `A snippet named “${existing.label}” already exists.\n\nReplace it with the current selection (${captured.nodeCount} node(s))?`,
      "Replace snippet"
    );
    if (!ok) return;

    state.items[existingIndex] = {
      ...existing,
      kind: "snippet",
      label: trimmed,
      type: `Snippet (${captured.nodeCount} nodes)`,
      data: captured.data,
      nodeCount: captured.nodeCount,
    };
  } else {
    state.items.unshift({
      id: uid("snip"),
      kind: "snippet",
      label: trimmed,
      type: `Snippet (${captured.nodeCount} nodes)`,
      data: captured.data,
      nodeCount: captured.nodeCount,
    });
  }

  saveItems();
  if (state.saveNameEl) state.saveNameEl.value = "";
  applyFilter(state.searchEl?.value || "");
  renderList();
  updateHint();
}

function onPointerMove(event) {
  state.clientX = event.clientX;
  state.clientY = event.clientY;
}

function onKeyDown(event) {
  if (state.dialogOpen) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeDialog(false);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      closeDialog(true);
      return;
    }
    return;
  }

  // Prevent hotkey bleed into Save Name / Filter inputs
  if (
    state.active &&
    (document.activeElement === state.saveNameEl || document.activeElement === state.searchEl)
  ) {
    if (isHotkeyEvent(event) || (event.repeat && event.key === state.hotkey)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
  }

  if (shouldIgnoreKeyEvent(event) && !state.active) return;

  if (isHotkeyEvent(event)) {
    if (event.repeat) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    const [x, y] = clientToCanvas(state.clientX, state.clientY);
    state.canvasX = x;
    state.canvasY = y;
    state.holding = true;
    void showPanel();
    return;
  }

  if (!state.active) return;

  if (document.activeElement === state.saveNameEl) {
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    hidePanel();
    return;
  }

  if (event.key >= "1" && event.key <= "9") {
    if (document.activeElement === state.searchEl && state.searchEl.value) return;
    const index = Number(event.key) - 1;
    const item = state.filtered[index];
    if (item) {
      event.preventDefault();
      event.stopPropagation();
      insertItem(item);
    }
    return;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveHighlight(1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    moveHighlight(-1);
  } else if (event.key === "Enter") {
    event.preventDefault();
    pickHighlighted();
  } else if (event.key === "Delete" || event.key === "Backspace") {
    if (document.activeElement !== state.searchEl || !state.searchEl.value) {
      event.preventDefault();
      event.stopPropagation();
      deleteHighlightedItem();
    }
  } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
    if (
      document.activeElement !== state.searchEl &&
      document.activeElement !== state.saveNameEl
    ) {
      state.searchEl?.focus();
    }
  }
}

function onKeyUp(event) {
  if (!isHotkeyEvent(event)) return;

  event.preventDefault();
  event.stopPropagation();
  state.holding = false;

  if (state.pinned) return;

  if (!state.active) return;
  if (
    document.activeElement === state.searchEl ||
    document.activeElement === state.saveNameEl
  ) {
    state.pinned = true;
    return;
  }

  if (state.hovered && state.filtered[state.highlight]) {
    pickHighlighted();
    return;
  }
  hidePanel();
}

function onWindowBlur() {
  if (state.active && !state.pinned) hidePanel();
}

function onDocumentPointerDown(event) {
  if (!state.active) return;
  if (state.dialogOpen) return;
  if (state.modalEl?.contains(event.target)) return;
  if (state.panel?.contains(event.target)) {
    state.pinned = true;
    return;
  }
  hidePanel();
}

function registerSettings() {
  try {
    app.ui.settings.addSetting({
      id: "QuickModulePicker.Hotkey",
      name: "Quick Paste Hotkey",
      type: "text",
      defaultValue: EXT.DEFAULT_HOTKEY,
      tooltip:
        "Hold this key to open the quick paste menu at the cursor. Default is the key left of 1 (Backquote `).",
      onChange: (value) => {
        saveHotkey(String(value || EXT.DEFAULT_HOTKEY));
        updateHint();
        refreshHelpContent();
      },
    });

    const current = app.ui.settings.getSettingValue?.(
      "QuickModulePicker.Hotkey",
      loadHotkey()
    );
    saveHotkey(String(current || loadHotkey()));
    // If settings still had the old middle-dot default, rewrite to Backquote
    if (normalizeHotkey(current) === EXT.DEFAULT_HOTKEY && String(current || "") === "·") {
      try {
        app.ui.settings.setSettingValue?.("QuickModulePicker.Hotkey", EXT.DEFAULT_HOTKEY);
      } catch (_) {}
    }
  } catch (_) {
    state.hotkey = loadHotkey();
  }
}

app.registerExtension({
  name: EXT.NAME,
  async setup() {
    state.hotkey = loadHotkey();
    registerSettings();
    ensureDom();
    await loadItems();
    updateHint();

    window.addEventListener("pointermove", onPointerMove, { capture: true, passive: true });
    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    window.addEventListener("blur", onWindowBlur);
    document.addEventListener("pointerdown", onDocumentPointerDown, { capture: true });
  },
});
