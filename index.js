import {
  createApp,
  defineComponent,
  computed,
  ref,
  nextTick,
  onBeforeUnmount,
  onMounted,
  watch,
} from "vue";
import {
  createRouter,
  createWebHashHistory,
  RouterView,
  RouterLink,
  useRouter,
  useRoute,
} from "vue-router";
import { GraffitiDecentralized } from "@graffiti-garden/implementation-decentralized";
import {
  GraffitiPlugin,
  useGraffiti,
  useGraffitiSession,
  useGraffitiDiscover,
} from "@graffiti-garden/wrapper-vue";

/** JSON Schema over the whole Graffiti object; filters on `value`. */
const chatSchema = {
  properties: {
    value: {
      required: ["type", "chatId", "name"],
      properties: {
        type: { const: "create_chat" },
        chatId: { type: "string" },
        name: { type: "string" },
        createdAt: { type: "number" },
        createdBy: { type: "string" },
        members: {
          type: "array",
          items: { type: "string" },
        },
      },
    },
  },
};

const updateChatProfileSchema = {
  properties: {
    value: {
      required: ["type", "chatId", "name", "photoUrl", "updatedAt", "updatedBy"],
      properties: {
        type: { const: "update_chat_profile" },
        chatId: { type: "string" },
        name: { type: "string" },
        photoUrl: { type: "string" },
        updatedAt: { type: "number" },
        updatedBy: { type: "string" },
      },
    },
  },
};

const addChatMemberSchema = {
  properties: {
    value: {
      required: ["type", "chatId", "actor", "addedAt", "addedBy"],
      properties: {
        type: { const: "add_chat_member" },
        chatId: { type: "string" },
        actor: { type: "string" },
        addedAt: { type: "number" },
        addedBy: { type: "string" },
      },
    },
  },
};

/** Creator-only: enable/disable invite links and rotate secret token (latest wins). */
const setChatInviteSchema = {
  properties: {
    value: {
      required: ["type", "chatId", "inviteToken", "updatedAt", "updatedBy"],
      properties: {
        type: { const: "set_chat_invite" },
        chatId: { type: "string" },
        inviteToken: { type: "string" },
        disabled: { type: "boolean" },
        updatedAt: { type: "number" },
        updatedBy: { type: "string" },
      },
    },
  },
};

/** create_chat, update_chat_profile, add_chat_member on the chats channel */
const chatsChannelSchema = {
  properties: {
    value: {
      oneOf: [
        chatSchema.properties.value,
        updateChatProfileSchema.properties.value,
        addChatMemberSchema.properties.value,
        setChatInviteSchema.properties.value,
      ],
    },
  },
};

const sendMessageValueSchema = {
  required: ["type", "messageId", "chatId", "content", "createdAt", "createdBy"],
  properties: {
    type: { const: "send_message" },
    messageId: { type: "string" },
    chatId: { type: "string" },
    content: { type: "string" },
    createdAt: { type: "number" },
    createdBy: { type: "string" },
    replyToMessageId: { type: "string" },
    kind: {
      enum: ["text", "file", "media", "poll", "contact"],
    },
    fileName: { type: "string" },
    fileType: { type: "string" },
    fileSize: { type: "number" },
    fileDataUrl: { type: "string" },
    poll: {
      type: "object",
      properties: {
        question: { type: "string" },
        options: {
          type: "array",
          items: { type: "string" },
        },
      },
    },
    contact: {
      type: "object",
      properties: {
        name: { type: "string" },
        detail: { type: "string" },
      },
    },
  },
};

const addMessageReactionValueSchema = {
  required: [
    "type",
    "reactionId",
    "chatId",
    "messageId",
    "emoji",
    "createdAt",
    "createdBy",
  ],
  properties: {
    type: { const: "add_message_reaction" },
    reactionId: { type: "string" },
    chatId: { type: "string" },
    messageId: { type: "string" },
    emoji: { type: "string" },
    createdAt: { type: "number" },
    createdBy: { type: "string" },
  },
};

const removeMessageReactionValueSchema = {
  required: [
    "type",
    "reactionId",
    "chatId",
    "messageId",
    "removedAt",
    "removedBy",
  ],
  properties: {
    type: { const: "remove_message_reaction" },
    reactionId: { type: "string" },
    chatId: { type: "string" },
    messageId: { type: "string" },
    removedAt: { type: "number" },
    removedBy: { type: "string" },
  },
};

const addPollVoteValueSchema = {
  required: [
    "type",
    "voteId",
    "chatId",
    "messageId",
    "optionIndex",
    "createdAt",
    "createdBy",
  ],
  properties: {
    type: { const: "add_poll_vote" },
    voteId: { type: "string" },
    chatId: { type: "string" },
    messageId: { type: "string" },
    optionIndex: { type: "integer", minimum: 0 },
    createdAt: { type: "number" },
    createdBy: { type: "string" },
  },
};

const removePollVoteValueSchema = {
  required: [
    "type",
    "voteId",
    "chatId",
    "messageId",
    "removedAt",
    "removedBy",
  ],
  properties: {
    type: { const: "remove_poll_vote" },
    voteId: { type: "string" },
    chatId: { type: "string" },
    messageId: { type: "string" },
    removedAt: { type: "number" },
    removedBy: { type: "string" },
  },
};

/** send_message + reaction records on the messages channel */
const messagesChannelSchema = {
  properties: {
    value: {
      oneOf: [
        sendMessageValueSchema,
        addMessageReactionValueSchema,
        removeMessageReactionValueSchema,
        addPollVoteValueSchema,
        removePollVoteValueSchema,
      ],
    },
  },
};

const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });
}

const CHATS_CHANNELS = ["chats"];
const MESSAGES_CHANNELS = ["messages"];
const PINS_CHANNELS = ["pins"];
const PROFILES_CHANNELS = ["profiles"];
const DESIGN_VERSIONS_CHANNELS = ["design_versions"];
const DESIGN_COMMENTS_CHANNELS = ["design_comments"];

const profileSchema = {
  properties: {
    value: {
      required: [
        "type",
        "actor",
        "username",
        "photoUrl",
        "theme",
        "updatedAt",
      ],
      properties: {
        type: { const: "set_profile" },
        actor: { type: "string" },
        username: { type: "string" },
        photoUrl: { type: "string" },
        theme: { enum: ["light", "dark"] },
        updatedAt: { type: "number" },
      },
    },
  },
};

const pinSchema = {
  properties: {
    value: {
      required: ["type", "pinId", "chatId", "messageId", "pinnedAt", "pinnedBy"],
      properties: {
        type: { const: "pin_message" },
        pinId: { type: "string" },
        chatId: { type: "string" },
        messageId: { type: "string" },
        pinnedAt: { type: "number" },
        pinnedBy: { type: "string" },
      },
    },
  },
};

const unpinSchema = {
  properties: {
    value: {
      required: ["type", "unpinId", "chatId", "messageId", "unpinnedAt", "unpinnedBy"],
      properties: {
        type: { const: "unpin_message" },
        unpinId: { type: "string" },
        chatId: { type: "string" },
        messageId: { type: "string" },
        unpinnedAt: { type: "number" },
        unpinnedBy: { type: "string" },
      },
    },
  },
};

/** Discover both pin and unpin records on the pins channel. */
const pinsDiscoverSchema = {
  properties: {
    value: {
      oneOf: [
        pinSchema.properties.value,
        unpinSchema.properties.value,
      ],
    },
  },
};

const createDesignVersionSchema = {
  properties: {
    value: {
      required: [
        "type",
        "versionId",
        "chatId",
        "title",
        "notes",
        "imageDataUrl",
        "status",
        "tags",
        "createdAt",
        "createdBy",
      ],
      properties: {
        type: { const: "create_design_version" },
        versionId: { type: "string" },
        chatId: { type: "string" },
        title: { type: "string" },
        notes: { type: "string" },
        imageDataUrl: { type: "string" },
        status: {
          enum: ["approved", "needs_revision", "archived", "draft"],
        },
        tags: {
          type: "array",
          items: { type: "string" },
        },
        createdAt: { type: "number" },
        createdBy: { type: "string" },
      },
    },
  },
};

const updateDesignVersionStatusSchema = {
  properties: {
    value: {
      required: [
        "type",
        "versionId",
        "chatId",
        "status",
        "updatedAt",
        "updatedBy",
      ],
      properties: {
        type: { const: "update_design_version_status" },
        versionId: { type: "string" },
        chatId: { type: "string" },
        status: {
          enum: ["approved", "needs_revision", "archived", "draft"],
        },
        updatedAt: { type: "number" },
        updatedBy: { type: "string" },
      },
    },
  },
};

const updateDesignVersionSchema = {
  properties: {
    value: {
      required: [
        "type",
        "versionId",
        "chatId",
        "title",
        "notes",
        "imageDataUrl",
        "tags",
        "updatedAt",
        "updatedBy",
      ],
      properties: {
        type: { const: "update_design_version" },
        versionId: { type: "string" },
        chatId: { type: "string" },
        title: { type: "string" },
        notes: { type: "string" },
        imageDataUrl: { type: "string" },
        tags: {
          type: "array",
          items: { type: "string" },
        },
        updatedAt: { type: "number" },
        updatedBy: { type: "string" },
      },
    },
  },
};

const hideDesignVersionSchema = {
  properties: {
    value: {
      required: ["type", "hideId", "versionId", "chatId", "hiddenAt", "hiddenBy"],
      properties: {
        type: { const: "hide_design_version" },
        hideId: { type: "string" },
        versionId: { type: "string" },
        chatId: { type: "string" },
        hiddenAt: { type: "number" },
        hiddenBy: { type: "string" },
      },
    },
  },
};

const restoreDesignVersionSchema = {
  properties: {
    value: {
      required: [
        "type",
        "restoreId",
        "versionId",
        "chatId",
        "restoredAt",
        "restoredBy",
      ],
      properties: {
        type: { const: "restore_design_version" },
        restoreId: { type: "string" },
        versionId: { type: "string" },
        chatId: { type: "string" },
        restoredAt: { type: "number" },
        restoredBy: { type: "string" },
      },
    },
  },
};

const designVersionsDiscoverSchema = {
  properties: {
    value: {
      oneOf: [
        createDesignVersionSchema.properties.value,
        updateDesignVersionSchema.properties.value,
        updateDesignVersionStatusSchema.properties.value,
        hideDesignVersionSchema.properties.value,
        restoreDesignVersionSchema.properties.value,
      ],
    },
  },
};

const designCommentSchema = {
  properties: {
    value: {
      required: [
        "type",
        "commentId",
        "versionId",
        "chatId",
        "content",
        "createdAt",
        "createdBy",
      ],
      properties: {
        type: { const: "create_design_comment" },
        commentId: { type: "string" },
        versionId: { type: "string" },
        chatId: { type: "string" },
        content: { type: "string" },
        createdAt: { type: "number" },
        createdBy: { type: "string" },
      },
    },
  },
};

/**
 * For each messageId, pinned iff latest pin_message time > latest unpin_message time.
 */
function computePinnedMessageIds(pinObjects, chatId) {
  const byMsg = new Map();
  for (const o of pinObjects) {
    const v = o.value;
    if (!v || v.chatId !== chatId) continue;
    let cur = byMsg.get(v.messageId) ?? { pinAt: 0, unpinAt: 0 };
    if (v.type === "pin_message") {
      cur.pinAt = Math.max(cur.pinAt, v.pinnedAt ?? 0);
    } else if (v.type === "unpin_message") {
      cur.unpinAt = Math.max(cur.unpinAt, v.unpinnedAt ?? 0);
    }
    byMsg.set(v.messageId, cur);
  }
  const ids = new Set();
  for (const [mid, t] of byMsg) {
    if (t.pinAt > t.unpinAt) ids.add(mid);
  }
  return ids;
}

/** Latest set_profile per actor by updatedAt (append-only). */
function profileIndexFromObjects(profileObjects) {
  const map = new Map();
  for (const o of profileObjects) {
    const v = o.value;
    if (!v || v.type !== "set_profile" || !v.actor) continue;
    const cur = map.get(v.actor);
    const curAt = cur?.value?.updatedAt ?? -1;
    const at = v.updatedAt ?? 0;
    if (!cur || at >= curAt) map.set(v.actor, o);
  }
  return map;
}

function getProfile(profileIndex, actor) {
  if (actor == null || actor === "") return null;
  return profileIndex.get(actor)?.value ?? null;
}

/** Friendly label when no profile username exists (e.g. `User ab12`). */
function defaultUsernameForActor(actor) {
  const raw = String(actor || "").replace(/-/g, "");
  const suffix =
    raw.length >= 4
      ? raw.slice(-4).toLowerCase()
      : `${raw}xxxx`.slice(0, 4).toLowerCase();
  return `User ${suffix}`;
}

function displayUser(profileIndex, actor) {
  const p = getProfile(profileIndex, actor);
  if (p?.username != null && String(p.username).trim() !== "") {
    return String(p.username).trim();
  }
  return defaultUsernameForActor(actor);
}

/** { photoUrl, initial } — initial for circular fallback avatar */
function displayAvatar(profileIndex, actor) {
  const p = getProfile(profileIndex, actor);
  const photoUrl =
    p?.photoUrl != null && String(p.photoUrl).trim() !== ""
      ? String(p.photoUrl).trim()
      : "";
  const label = displayUser(profileIndex, actor);
  const initial = (label && label[0] ? label[0] : String(actor || "?")[0]).toUpperCase();
  return { photoUrl, initial };
}

/**
 * Effective chat display: latest create_chat + latest update_chat_profile + member adds.
 */
function mergeChatMeta(chatId, chatObjects) {
  let bestCreate = null;
  let bestCreateAt = -1;
  let bestUpdate = null;
  let bestUpdateAt = -1;
  let bestInvite = null;
  let bestInviteAt = -1;
  const addedRows = [];
  for (const o of chatObjects) {
    const v = o.value;
    if (!v || v.chatId !== chatId) continue;
    if (v.type === "create_chat") {
      const at = v.createdAt ?? 0;
      if (at >= bestCreateAt) {
        bestCreateAt = at;
        bestCreate = v;
      }
    } else if (v.type === "update_chat_profile") {
      const at = v.updatedAt ?? 0;
      if (at >= bestUpdateAt) {
        bestUpdateAt = at;
        bestUpdate = v;
      }
    } else if (v.type === "set_chat_invite") {
      const at = v.updatedAt ?? 0;
      if (at >= bestInviteAt) {
        bestInviteAt = at;
        bestInvite = v;
      }
    } else if (v.type === "add_chat_member") {
      addedRows.push(v);
    }
  }
  const baseName =
    typeof bestCreate?.name === "string" ? bestCreate.name : "Chat";
  const baseMembers = Array.isArray(bestCreate?.members)
    ? [...bestCreate.members]
    : [];
  const memberSet = new Set(baseMembers);
  for (const v of addedRows) {
    if (v.actor) memberSet.add(v.actor);
  }
  const members = [...memberSet];
  const name =
    bestUpdate && typeof bestUpdate.name === "string"
      ? bestUpdate.name
      : baseName;
  const photoUrl =
    bestUpdate && typeof bestUpdate.photoUrl === "string"
      ? String(bestUpdate.photoUrl).trim()
      : "";
  const inviteDisabled = !!(bestInvite && bestInvite.disabled);
  const inviteTokRaw =
    typeof bestInvite?.inviteToken === "string"
      ? bestInvite.inviteToken.trim()
      : "";
  const inviteToken = inviteDisabled ? "" : inviteTokRaw;
  return {
    name,
    photoUrl,
    members,
    createdBy: bestCreate?.createdBy ?? null,
    createdAt: bestCreate?.createdAt ?? null,
    roomId: chatId,
    isGroup: members.length > 2,
    chatExists: bestCreate != null,
    inviteToken,
    inviteLinkEnabled: inviteToken.length > 0,
  };
}

/**
 * UI-only: may this actor treat this room as accessible in our app?
 * Creator or merged `members` (create_chat + add_chat_member) qualifies.
 *
 * Graffiti objects on shared global channels may still be discoverable to other clients;
 * real privacy needs per-chat capability channels, private inboxes, or encrypted payloads.
 */
function canAccessChat(chatMeta, actor) {
  if (!actor) return false;
  if (chatMeta.createdBy === actor) return true;
  return Array.isArray(chatMeta.members) && chatMeta.members.includes(actor);
}

/** UI-only: chat creator — member list, invites, profile edits where enforced. */
function canManageChat(chatMeta, actor) {
  return !!actor && chatMeta.createdBy === actor;
}

/** Full URL for hash-router invite (token must match latest `set_chat_invite` on the chats channel). */
function buildStudioInviteUrl(chatId, inviteToken) {
  if (typeof window === "undefined") return "";
  const path = `${window.location.pathname}${window.location.search}`;
  return `${window.location.origin}${path}#/join/${encodeURIComponent(chatId)}/${encodeURIComponent(inviteToken)}`;
}

const LAST_READ_STORAGE_PREFIX = "studio-chats-last-read:v1:";

function lastReadStorageKey(actor) {
  return LAST_READ_STORAGE_PREFIX + encodeURIComponent(actor);
}

function loadLastReadMapForActor(actor) {
  if (!actor) return {};
  try {
    const raw = localStorage.getItem(lastReadStorageKey(actor));
    if (!raw) return {};
    const o = JSON.parse(raw);
    return typeof o === "object" && o != null && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

function persistLastReadMap(actor, map) {
  if (!actor) return;
  try {
    localStorage.setItem(lastReadStorageKey(actor), JSON.stringify(map));
  } catch (e) {
    console.warn(e);
  }
}

/** Max `send_message` `createdAt` this actor has seen per chat (device-local; sidebar unread). */
const lastReadAtByChatId = ref(/** @type {Record<string, number>} */ ({}));

function syncLastReadMapFromStorage(actor) {
  lastReadAtByChatId.value = actor
    ? { ...loadLastReadMapForActor(actor) }
    : {};
}

function markChatReadUpTo(chatId, maxCreatedAt, actor) {
  if (!actor || !chatId) return;
  if (typeof maxCreatedAt !== "number" || !Number.isFinite(maxCreatedAt)) return;
  const prev = lastReadAtByChatId.value[chatId] ?? 0;
  if (maxCreatedAt <= prev) return;
  const next = { ...lastReadAtByChatId.value, [chatId]: maxCreatedAt };
  lastReadAtByChatId.value = next;
  persistLastReadMap(actor, next);
}

/** True if latest hide time for versionId is after latest restore (soft-removed from list). */
function isDesignVersionHidden(versionObjects, versionId) {
  let lastHide = -1;
  let lastRestore = -1;
  for (const o of versionObjects) {
    const v = o.value;
    if (!v || v.versionId !== versionId) continue;
    if (v.type === "hide_design_version") {
      lastHide = Math.max(lastHide, v.hiddenAt ?? 0);
    } else if (v.type === "restore_design_version") {
      lastRestore = Math.max(lastRestore, v.restoredAt ?? 0);
    }
  }
  return lastHide > lastRestore;
}

/**
 * Effective design versions for one chat: latest create + latest status update per versionId.
 * Sorted newest first by createdAt. Omits versions hidden by hide_design_version (until restored).
 */
function mergeDesignVersions(versionObjects) {
  const creates = new Map();
  for (const o of versionObjects) {
    const v = o.value;
    if (!v || v.type !== "create_design_version" || !v.versionId) continue;
    creates.set(v.versionId, { ...v });
  }
  const statusBest = new Map();
  for (const o of versionObjects) {
    const v = o.value;
    if (!v || v.type !== "update_design_version_status" || !v.versionId) continue;
    const cur = statusBest.get(v.versionId);
    const at = v.updatedAt ?? 0;
    if (!cur || at >= (cur.updatedAt ?? 0)) {
      statusBest.set(v.versionId, {
        status: v.status,
        updatedAt: at,
        updatedBy: v.updatedBy,
      });
    }
  }
  const contentPatch = new Map();
  for (const o of versionObjects) {
    const v = o.value;
    if (!v || v.type !== "update_design_version" || !v.versionId) continue;
    const cur = contentPatch.get(v.versionId);
    const at = v.updatedAt ?? 0;
    if (!cur || at >= (cur.updatedAt ?? 0)) {
      contentPatch.set(v.versionId, {
        title: v.title,
        notes: v.notes,
        imageDataUrl: v.imageDataUrl,
        tags: v.tags,
        updatedAt: at,
      });
    }
  }
  const out = [];
  for (const [versionId, base] of creates) {
    const st = statusBest.get(versionId);
    const patch = contentPatch.get(versionId);
    const row = {
      ...base,
      versionId,
      status: st ? st.status : base.status,
    };
    if (patch) {
      if (patch.title != null) row.title = patch.title;
      if (patch.notes != null) row.notes = patch.notes;
      if (patch.imageDataUrl != null) row.imageDataUrl = patch.imageDataUrl;
      if (patch.tags != null) row.tags = patch.tags;
    }
    out.push(row);
  }
  const visible = out.filter(
    (row) => !isDesignVersionHidden(versionObjects, row.versionId),
  );
  visible.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return visible;
}

function designTagsEqual(a, b) {
  const aa = [...(a || [])].map(String).sort();
  const bb = [...(b || [])].map(String).sort();
  if (aa.length !== bb.length) return false;
  return aa.every((x, i) => x === bb[i]);
}

/** Comments for one version, oldest first (full Graffiti objects). */
function commentsForVersion(commentObjects, versionId) {
  const rows = [];
  for (const o of commentObjects) {
    const v = o.value;
    if (!v || v.type !== "create_design_comment") continue;
    if (v.versionId !== versionId) continue;
    rows.push(o);
  }
  rows.sort(
    (a, b) =>
      (a.value.createdAt ?? 0) - (b.value.createdAt ?? 0),
  );
  return rows;
}

function commentCountForVersion(commentObjects, chatId, versionId) {
  let n = 0;
  for (const o of commentObjects) {
    const v = o.value;
    if (
      v?.type === "create_design_comment" &&
      v.chatId === chatId &&
      v.versionId === versionId
    ) {
      n++;
    }
  }
  return n;
}

function parseCommaTags(s) {
  if (typeof s !== "string" || !s.trim()) return [];
  return s
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function messagePreviewLabel(msgVal) {
  if (!msgVal || msgVal.type !== "send_message") return "";
  const k = msgVal.kind || "text";
  if (k === "text") return msgVal.content ?? "";
  if (k === "file") return "📎 File";
  if (k === "media") return "🖼️ Media";
  if (k === "poll") return "📊 Poll";
  if (k === "contact") return "👤 Contact";
  return msgVal.content ?? "";
}

function messageMatchesSearch(msgObj, queryLower) {
  const v = msgObj?.value;
  if (!v || v.type !== "send_message" || !queryLower) return false;
  const blob = [
    messagePreviewLabel(v),
    typeof v.content === "string" ? v.content : "",
    v.fileName != null ? String(v.fileName) : "",
  ]
    .join(" ")
    .toLowerCase();
  return blob.includes(queryLower);
}

/** Active add_message_reaction rows per messageId (removals applied by reactionId). */
function activeReactionsByMessageId(messageObjects, chatId) {
  const adds = [];
  const removed = new Set();
  for (const o of messageObjects) {
    const v = o.value;
    if (!v || v.chatId !== chatId) continue;
    if (v.type === "add_message_reaction") adds.push(v);
    else if (v.type === "remove_message_reaction") removed.add(v.reactionId);
  }
  const byMessage = new Map();
  for (const v of adds) {
    if (removed.has(v.reactionId)) continue;
    if (!byMessage.has(v.messageId)) byMessage.set(v.messageId, []);
    byMessage.get(v.messageId).push({
      reactionId: v.reactionId,
      emoji: v.emoji,
      createdBy: v.createdBy,
    });
  }
  return byMessage;
}

function reactionChipRowsForMessage(messageId, byMessage, myActor) {
  const list = byMessage.get(messageId) ?? [];
  const byEmoji = new Map();
  for (const r of list) {
    if (!byEmoji.has(r.emoji)) {
      byEmoji.set(r.emoji, {
        emoji: r.emoji,
        count: 0,
        myReactionId: null,
      });
    }
    const row = byEmoji.get(r.emoji);
    row.count++;
    if (myActor && r.createdBy === myActor) {
      row.myReactionId = r.reactionId;
    }
  }
  return [...byEmoji.values()];
}

/** Latest non-removed vote per actor per poll message (for tally + changing vote). */
function activePollVotesByMessageId(messageObjects, chatId) {
  const adds = [];
  const removed = new Set();
  for (const o of messageObjects) {
    const v = o.value;
    if (!v || v.chatId !== chatId) continue;
    if (v.type === "add_poll_vote") adds.push(v);
    else if (v.type === "remove_poll_vote") removed.add(v.voteId);
  }
  const byMessage = new Map();
  for (const v of adds) {
    if (removed.has(v.voteId)) continue;
    const mid = v.messageId;
    if (!mid) continue;
    if (!byMessage.has(mid)) byMessage.set(mid, new Map());
    const actorMap = byMessage.get(mid);
    const actor = v.createdBy;
    const at = v.createdAt ?? 0;
    const prev = actorMap.get(actor);
    if (prev && prev.createdAt >= at) continue;
    actorMap.set(actor, {
      voteId: v.voteId,
      optionIndex: v.optionIndex,
      createdAt: at,
    });
  }
  return byMessage;
}

/** Tallies + current user's vote for one poll bubble. */
function pollVisualForMessage(msgObj, pollVotesByMessage, sessionActor) {
  const v = msgObj?.value;
  if (v?.kind !== "poll") return null;
  const opts = v.poll?.options ?? [];
  const n = opts.length;
  if (!n) return null;
  const counts = Array(n).fill(0);
  const mid = v.messageId;
  const actorMap = pollVotesByMessage.get(mid);
  let myIndex = null;
  let myVoteId = null;
  if (actorMap) {
    for (const [actor, row] of actorMap) {
      const i = row.optionIndex;
      if (typeof i === "number" && i >= 0 && i < n) counts[i] += 1;
      if (sessionActor && actor === sessionActor) {
        myVoteId = row.voteId;
        myIndex = typeof i === "number" && i >= 0 && i < n ? i : null;
      }
    }
  }
  return { counts, myIndex, myVoteId };
}

async function postPollVoteSelection({
  graffiti,
  session: s,
  chatId,
  messageId,
  optionIndex,
  prevVote,
}) {
  if (!s?.actor || !chatId || messageId == null) return false;
  if (
    typeof optionIndex !== "number" ||
    !Number.isInteger(optionIndex) ||
    optionIndex < 0
  ) {
    return false;
  }
  try {
    if (prevVote && prevVote.optionIndex === optionIndex) return true;
    if (prevVote?.voteId) {
      await graffiti.post(
        {
          value: {
            type: "remove_poll_vote",
            voteId: prevVote.voteId,
            chatId,
            messageId,
            removedAt: Date.now(),
            removedBy: s.actor,
          },
          channels: MESSAGES_CHANNELS,
        },
        s,
      );
    }
    await graffiti.post(
      {
        value: {
          type: "add_poll_vote",
          voteId: crypto.randomUUID(),
          chatId,
          messageId,
          optionIndex,
          createdAt: Date.now(),
          createdBy: s.actor,
        },
        channels: MESSAGES_CHANNELS,
      },
      s,
    );
    return true;
  } catch (e) {
    console.error(e);
    return false;
  }
}

function truncateSnippet(s, maxLen) {
  if (s == null) return "";
  const t = String(s).replace(/\s+/g, " ").trim();
  if (t.length <= maxLen) return t;
  return t.slice(0, maxLen - 1) + "…";
}

/** Copy helper — returns whether clipboard succeeded (no alert; caller may toast). */
async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(String(text ?? ""));
    return true;
  } catch {
    return false;
  }
}

/**
 * Split message text into `{ kind: 'text'|'link', text, href? }[]` for safe rendering (no HTML injection).
 */
function splitTextWithLinks(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    return [{ kind: "text", text: raw || "" }];
  }
  const out = [];
  const re =
    /\b(https?:\/\/[^\s<]+[^\s<.,:;"'`)}\]]|mailto:[^\s<]+[^\s<.,:;"'`)}\]])/gi;
  let last = 0;
  let m;
  while ((m = re.exec(raw)) !== null) {
    if (m.index > last) {
      out.push({ kind: "text", text: raw.slice(last, m.index) });
    }
    const href = m[0];
    out.push({ kind: "link", text: href, href });
    last = m.index + href.length;
  }
  if (last < raw.length) {
    out.push({ kind: "text", text: raw.slice(last) });
  }
  return out.length ? out : [{ kind: "text", text: raw }];
}

function isSafeMessageHref(href) {
  if (typeof href !== "string") return false;
  const h = href.trim();
  return (
    h.startsWith("https://") ||
    h.startsWith("http://") ||
    h.startsWith("mailto:")
  );
}

/** Short opaque id for secondary UI (not a security truncation). */
function shortOpaqueId(id) {
  const s = String(id || "").replace(/-/g, "");
  if (s.length <= 12) return s || "—";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

const MessageBubble = defineComponent({
  name: "MessageBubble",
  props: {
    message: { type: Object, required: true },
    isOwn: { type: Boolean, default: false },
    isPinned: { type: Boolean, default: false },
    canAct: { type: Boolean, default: false },
    senderLabel: { type: String, required: true },
    avatarPhotoUrl: { type: String, default: "" },
    avatarInitial: { type: String, default: "?" },
    /** Controlled by ChatView: which message's menu is open */
    actionsMenuOpen: { type: Boolean, default: false },
    /** Quoted reply header when this message is a reply */
    replyQuote: {
      type: Object,
      default: null,
    },
    /** { emoji, count, myReactionId }[] */
    reactionChips: {
      type: Array,
      default: () => [],
    },
    sessionActor: { type: String, default: "" },
    /** `{ counts, myIndex, myVoteId }` for poll messages; null otherwise */
    pollVisual: {
      type: Object,
      default: null,
    },
  },
  emits: [
    "toggle-actions-menu",
    "close-actions-menu",
    "pin",
    "unpin",
    "request-delete",
    "reply",
    "reaction-chip",
    "poll-vote",
  ],
  setup(props, { emit }) {
    const messageKind = computed(
      () => props.message.value?.kind || "text",
    );

    const textLinkParts = computed(() => {
      if (messageKind.value !== "text") return [];
      return splitTextWithLinks(props.message.value?.content ?? "");
    });

    function formatTime(ts) {
      if (ts == null) return "";
      try {
        return new Date(ts).toLocaleString(undefined, {
          hour: "numeric",
          minute: "2-digit",
        });
      } catch {
        return "";
      }
    }

    function formatBytes(n) {
      if (n == null || Number.isNaN(n)) return "";
      if (n < 1024) return `${n} B`;
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
      return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    }

    function closeMenu() {
      emit("close-actions-menu");
    }

    function toggleMenu() {
      emit("toggle-actions-menu");
    }

    function onReply() {
      emit("reply", props.message);
      closeMenu();
    }

    function onPin() {
      emit("pin", props.message);
      closeMenu();
    }

    function onUnpin() {
      emit("unpin", props.message);
      closeMenu();
    }

    function copyPayload() {
      const v = props.message.value;
      const k = messageKind.value;
      if (k === "text") return v.content ?? "";
      if (k === "file" || k === "media") {
        return [v.fileName, v.fileType, formatBytes(v.fileSize)]
          .filter(Boolean)
          .join("\n");
      }
      if (k === "poll") {
        const q = v.poll?.question ?? v.content ?? "";
        const opts = (v.poll?.options ?? []).join("\n");
        return opts ? `${q}\n${opts}` : q;
      }
      if (k === "contact") {
        return `${v.contact?.name ?? ""}\n${v.contact?.detail ?? ""}`.trim();
      }
      return String(v.content ?? "");
    }

    async function onCopy() {
      try {
        await navigator.clipboard.writeText(copyPayload());
      } catch {
        alert("Could not copy to clipboard.");
      }
      closeMenu();
    }

    function onDelete() {
      emit("request-delete", props.message);
      closeMenu();
    }

    function onReactionChipClick(emoji, myReactionId) {
      emit("reaction-chip", { emoji, myReactionId });
    }

    function onPollVote(optionIndex) {
      if (!props.sessionActor) return;
      emit("poll-vote", optionIndex);
    }

    return {
      messageKind,
      textLinkParts,
      isSafeMessageHref,
      formatTime,
      formatBytes,
      toggleMenu,
      onReply,
      onPin,
      onUnpin,
      onCopy,
      onDelete,
      onPollVote,
      onReactionChipClick,
    };
  },
  template: `
    <div class="bubble-wrap" :class="{ 'bubble-wrap--own': isOwn }">
      <div v-if="!isOwn" class="bubble-avatar-aside" aria-hidden="true">
        <img
          v-if="avatarPhotoUrl"
          :src="avatarPhotoUrl"
          alt=""
          class="bubble-avatar-img"
          loading="lazy"
        />
        <div v-else class="bubble-avatar-fallback">{{ avatarInitial }}</div>
      </div>
      <div class="bubble-cluster">
        <div class="bubble" :class="isOwn ? 'bubble--own' : 'bubble--other'">
          <div v-if="!isOwn" class="who">{{ senderLabel }}</div>

          <div v-if="replyQuote" class="bubble-reply-quote">
            <span class="bubble-reply-quote-label">↩ {{ replyQuote.senderLabel }}</span>
            <p class="bubble-reply-quote-snippet">{{ replyQuote.snippet }}</p>
          </div>

          <template v-if="messageKind === 'text'">
            <p class="text text--linkified">
              <template v-for="(seg, si) in textLinkParts" :key="'tl-' + si">
                <a
                  v-if="seg.kind === 'link' && isSafeMessageHref(seg.href)"
                  class="msg-text-link"
                  :href="seg.href"
                  target="_blank"
                  rel="noopener noreferrer"
                  @click.stop
                >{{ seg.text }}</a>
                <span v-else>{{ seg.text }}</span>
              </template>
            </p>
          </template>

          <template v-else-if="messageKind === 'file'">
            <div class="msg-file-card">
              <span class="msg-file-ico" aria-hidden="true">📄</span>
              <div class="msg-file-meta">
                <div class="msg-file-name">{{ message.value.fileName || message.value.content }}</div>
                <div class="msg-file-sub">{{ formatBytes(message.value.fileSize) }} · {{ message.value.fileType || 'file' }}</div>
              </div>
              <a
                class="msg-file-link"
                :href="message.value.fileDataUrl"
                :download="message.value.fileName || 'download'"
              >Open</a>
            </div>
          </template>

          <template v-else-if="messageKind === 'media'">
            <div class="msg-media-wrap">
              <img
                v-if="message.value.fileType && message.value.fileType.startsWith('image/')"
                :src="message.value.fileDataUrl"
                :alt="message.value.fileName || ''"
                class="msg-media-img"
              />
              <video
                v-else-if="message.value.fileType && message.value.fileType.startsWith('video/')"
                :src="message.value.fileDataUrl"
                class="msg-media-video"
                controls
                playsinline
              ></video>
              <div v-else class="msg-media-fallback">
                <a
                  class="msg-file-link"
                  :href="message.value.fileDataUrl"
                  :download="message.value.fileName || 'download'"
                >Download media</a>
              </div>
              <div class="msg-media-caption">{{ message.value.fileName || message.value.content }}</div>
            </div>
          </template>

          <template v-else-if="messageKind === 'poll'">
            <div class="msg-poll-card">
              <div class="msg-poll-q">{{ message.value.poll?.question || message.value.content }}</div>
              <button
                v-for="(opt, idx) in (message.value.poll?.options || [])"
                :key="idx"
                type="button"
                class="msg-poll-option"
                :class="{ 'msg-poll-option--picked': pollVisual && pollVisual.myIndex === idx }"
                :disabled="!sessionActor"
                @click="onPollVote(idx)"
              >
                <span class="msg-poll-option-label">{{ opt }}</span>
                <span
                  v-if="pollVisual && (pollVisual.counts[idx] || 0) > 0"
                  class="msg-poll-option-count"
                >{{ pollVisual.counts[idx] }}</span>
              </button>
            </div>
          </template>

          <template v-else-if="messageKind === 'contact'">
            <div class="msg-contact-card">
              <div class="msg-contact-avatar" aria-hidden="true">
                {{ (message.value.contact?.name || message.value.content || '?').slice(0, 1).toUpperCase() }}
              </div>
              <div class="msg-contact-body">
                <div class="msg-contact-name">{{ message.value.contact?.name || message.value.content }}</div>
                <div class="msg-contact-detail">{{ message.value.contact?.detail }}</div>
              </div>
            </div>
          </template>

          <div class="bubble-meta">
            <span class="when">{{ formatTime(message.value.createdAt) }}</span>
            <span v-if="isPinned" class="bubble-pin-badge" title="Pinned message"><span aria-hidden="true">📌</span><span class="bubble-pin-badge-text">Pinned</span></span>
          </div>
          <div v-if="reactionChips.length" class="bubble-reaction-row">
            <button
              v-for="(chip, ci) in reactionChips"
              :key="chip.emoji + '-' + ci"
              type="button"
              class="bubble-reaction-chip"
              :class="{ 'bubble-reaction-chip--mine': !!chip.myReactionId }"
              :disabled="!sessionActor"
              @click.stop="sessionActor && onReactionChipClick(chip.emoji, chip.myReactionId)"
            >
              <span class="bubble-reaction-emoji" aria-hidden="true">{{ chip.emoji }}</span>
              <span class="bubble-reaction-count">{{ chip.count }}</span>
            </button>
          </div>
        </div>
        <div
          v-if="canAct"
          class="bubble-actions"
          :data-message-actions-root="message.value.messageId"
          @click.stop
        >
          <button
            type="button"
            class="bubble-menu-btn"
            :class="{ 'bubble-menu-btn--open': actionsMenuOpen }"
            :aria-expanded="actionsMenuOpen"
            aria-label="Message actions"
            @click.stop="toggleMenu"
          >
            <svg class="bubble-menu-dots" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="5" cy="12" r="2.25" fill="currentColor" />
              <circle cx="12" cy="12" r="2.25" fill="currentColor" />
              <circle cx="19" cy="12" r="2.25" fill="currentColor" />
            </svg>
          </button>
          <transition name="bubble-menu-pop">
            <div
              v-show="actionsMenuOpen"
              class="bubble-menu bubble-menu--rich"
              role="menu"
              aria-label="Message actions"
              @click.stop
            >
            <p class="bubble-menu-head">Message</p>
            <button type="button" role="menuitem" class="bubble-menu-row" @click="onReply">
              <span class="bubble-menu-icon-wrap bubble-menu-icon-wrap--reply" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <path d="M9 14 4 9l5-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
                  <path d="M4 9h8.5a4.5 4.5 0 0 1 4.5 4.5V19" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
                </svg>
              </span>
              <span class="bubble-menu-label">Reply</span>
            </button>
            <button
              v-if="!isPinned"
              type="button"
              role="menuitem"
              class="bubble-menu-row"
              @click="onPin"
            >
              <span class="bubble-menu-icon-wrap bubble-menu-icon-wrap--pin" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <path d="M12 17v5M8 9l4-5 4 5v8H8V9z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
                  <path d="M6 2h12v4H6V2z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
                </svg>
              </span>
              <span class="bubble-menu-label">Pin</span>
            </button>
            <button v-else type="button" role="menuitem" class="bubble-menu-row" @click="onUnpin">
              <span class="bubble-menu-icon-wrap bubble-menu-icon-wrap--unpin" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <path d="M6 3h12v4H6V3z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
                  <path d="M9 7v11h6V7M12 18v3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
                  <path d="m5 19 14-14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
                </svg>
              </span>
              <span class="bubble-menu-label">Unpin</span>
            </button>
            <button type="button" role="menuitem" class="bubble-menu-row" @click="onCopy">
              <span class="bubble-menu-icon-wrap bubble-menu-icon-wrap--copy" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <rect x="8" y="8" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.6"/>
                  <path d="M6 16H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="1.6"/>
                </svg>
              </span>
              <span class="bubble-menu-label">Copy</span>
            </button>
            <div class="bubble-menu-divider" role="separator"></div>
            <button
              type="button"
              role="menuitem"
              class="bubble-menu-row bubble-menu-row--danger"
              @click="onDelete"
            >
              <span class="bubble-menu-icon-wrap bubble-menu-icon-wrap--delete" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <path d="M3 6h18M8 6V4h8v2M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
                  <path d="M10 11v6M14 11v6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
                </svg>
              </span>
              <span class="bubble-menu-label">Delete for me</span>
            </button>
            </div>
          </transition>
        </div>
      </div>
      <div v-if="isOwn" class="bubble-avatar-aside" aria-hidden="true">
        <img
          v-if="avatarPhotoUrl"
          :src="avatarPhotoUrl"
          alt=""
          class="bubble-avatar-img"
          loading="lazy"
        />
        <div v-else class="bubble-avatar-fallback">{{ avatarInitial }}</div>
      </div>
    </div>
  `,
});

const HomeView = defineComponent({
  name: "HomeView",
  template: `
    <div class="chat-panel-empty">
      <div>
        <p class="chat-panel-empty-title">Studio Chats</p>
        <p class="chat-panel-empty-text">Select a chat to start messaging</p>
      </div>
    </div>
  `,
});

const NewChatView = defineComponent({
  name: "NewChatView",
  setup() {
    const session = useGraffitiSession();
    const graffiti = useGraffiti();
    const router = useRouter();
    const name = ref("");
    const busy = ref(false);
    const error = ref("");

    async function submit() {
      error.value = "";
      const s = session.value;
      if (!s?.actor) {
        error.value = "Log in to create a chat.";
        return;
      }
      const trimmed = name.value.trim();
      if (!trimmed) {
        error.value = "Enter a chat name.";
        return;
      }
      busy.value = true;
      try {
        const chatId = crypto.randomUUID();
        await graffiti.post(
          {
            value: {
              type: "create_chat",
              chatId,
              name: trimmed,
              createdAt: Date.now(),
              createdBy: s.actor,
              members: [s.actor],
            },
            channels: CHATS_CHANNELS,
          },
          s,
        );
        router.push("/chat/" + chatId);
      } catch (e) {
        console.error(e);
        error.value = "Could not create the chat. Try again.";
      } finally {
        busy.value = false;
      }
    }

    return { session, name, busy, error, submit };
  },
  template: `
    <div class="chat-panel-static">
      <div class="chat-panel-static-inner">
        <h2>New chat</h2>
        <p v-if="session === undefined" class="hint">Loading…</p>
        <p v-else-if="session === null" class="hint">Log in from the sidebar to create a chat.</p>
        <form v-else @submit.prevent="submit">
          <p class="hint hint--join">To add someone to a chat, share an invite link from Chat Info → Invite link (creator only), or paste their member ID in Chat Info → Members.</p>
          <label for="new-chat-name">Chat name</label>
          <input
            id="new-chat-name"
            v-model="name"
            type="text"
            autocomplete="off"
            placeholder="e.g. Team sync"
          />
          <p v-if="error" class="hint">{{ error }}</p>
          <button type="submit" class="btn btn-primary" :disabled="busy">{{ busy ? 'Creating…' : 'Create chat' }}</button>
        </form>
      </div>
    </div>
  `,
});

const ChatView = defineComponent({
  name: "ChatView",
  components: { MessageBubble },
  props: {
    chatId: { type: String, required: true },
  },
  setup(props) {
    const session = useGraffitiSession();
    const graffiti = useGraffiti();
    const router = useRouter();
    const content = ref("");
    const busy = ref(false);
    const error = ref("");
    /** Which message's ⋯ menu is open (messageId), or null */
    const openActionsMessageId = ref(null);
    /** Locally hidden message IDs for this session only (Delete menu) */
    const hiddenLocalMessageIds = ref(new Set());

    const { objects: chatObjects, isFirstPoll: isFirstChatPoll } = useGraffitiDiscover(
      CHATS_CHANNELS,
      chatsChannelSchema,
    );

    const chatMeta = computed(() =>
      mergeChatMeta(props.chatId, chatObjects.value),
    );
    const chatName = computed(() => chatMeta.value.name || "Chat");
    const headerPhotoUrl = computed(() => chatMeta.value.photoUrl || "");

    const canViewChat = computed(() =>
      canAccessChat(chatMeta.value, session.value?.actor),
    );

    const canManageMembers = computed(() =>
      canManageChat(chatMeta.value, session.value?.actor),
    );

    const showChatAccessDenied = computed(() => {
      const actor = session.value?.actor;
      if (!actor) return false;
      if (isFirstChatPoll.value) return false;
      return !canAccessChat(chatMeta.value, actor);
    });

    const showChatAccessLoading = computed(
      () => !!session.value?.actor && isFirstChatPoll.value,
    );

    const chatInfoOpen = ref(false);
    const editChatName = ref("");
    const editPhotoUrl = ref("");
    const newMemberActor = ref("");
    const chatInfoBusy = ref(false);
    const chatInfoError = ref("");
    const chatInfoSearchQuery = ref("");

    function openChatInfo() {
      if (!canViewChat.value) return;
      const m = chatMeta.value;
      editChatName.value = m.name || "";
      editPhotoUrl.value = m.photoUrl || "";
      chatInfoSearchQuery.value = "";
      newMemberActor.value = "";
      chatInfoError.value = "";
      chatInfoOpen.value = true;
    }

    function closeChatInfo() {
      chatInfoOpen.value = false;
    }

    function openUserProfile(actor) {
      if (!actor) return;
      closeChatInfo();
      router.push({ name: "user-profile", params: { actorId: actor } });
    }

    async function saveChatProfile() {
      const s = session.value;
      if (!s?.actor) {
        chatInfoError.value = "Log in to save.";
        return;
      }
      if (!canViewChat.value) {
        chatInfoError.value = "You do not have access to this chat.";
        return;
      }
      chatInfoBusy.value = true;
      chatInfoError.value = "";
      try {
        await graffiti.post(
          {
            value: {
              type: "update_chat_profile",
              chatId: props.chatId,
              name: editChatName.value.trim() || chatMeta.value.name || "Chat",
              photoUrl: editPhotoUrl.value.trim(),
              updatedAt: Date.now(),
              updatedBy: s.actor,
            },
            channels: CHATS_CHANNELS,
          },
          s,
        );
      } catch (e) {
        console.error(e);
        chatInfoError.value = "Could not save chat profile.";
      } finally {
        chatInfoBusy.value = false;
      }
    }

    async function submitAddChatMember() {
      const s = session.value;
      if (!s?.actor) {
        chatInfoError.value = "Log in to add members.";
        return;
      }
      if (!canViewChat.value) {
        chatInfoError.value = "You do not have access to this chat.";
        return;
      }
      if (!canManageMembers.value) {
        chatInfoError.value = "Only the chat creator can add members.";
        return;
      }
      const actor = newMemberActor.value.trim();
      if (!actor) {
        chatInfoError.value = "Enter a member ID.";
        return;
      }
      const existing = new Set(chatMeta.value.members);
      if (existing.has(actor)) {
        chatInfoError.value = "That member is already in this chat.";
        return;
      }
      chatInfoBusy.value = true;
      chatInfoError.value = "";
      try {
        await graffiti.post(
          {
            value: {
              type: "add_chat_member",
              chatId: props.chatId,
              actor,
              addedAt: Date.now(),
              addedBy: s.actor,
            },
            channels: CHATS_CHANNELS,
          },
          s,
        );
        newMemberActor.value = "";
      } catch (e) {
        console.error(e);
        chatInfoError.value = "Could not add member.";
      } finally {
        chatInfoBusy.value = false;
      }
    }

    function chatInfoSnippet(msgObj) {
      const v = msgObj.value;
      const line =
        messagePreviewLabel(v) ||
        (v?.content != null ? String(v.content) : "");
      if (line.length > 100) return line.slice(0, 97) + "…";
      return line;
    }

    function formatMsgInfoTime(ts) {
      if (ts == null) return "—";
      try {
        return new Date(ts).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });
      } catch {
        return "—";
      }
    }

    function onChatInfoSearchPick() {
      closeChatInfo();
    }

    const { objects, isFirstPoll } = useGraffitiDiscover(
      MESSAGES_CHANNELS,
      messagesChannelSchema,
      undefined,
      true,
    );

    const { objects: pinChannelObjects } = useGraffitiDiscover(
      PINS_CHANNELS,
      pinsDiscoverSchema,
    );

    const { objects: designVersionRawObjects } = useGraffitiDiscover(
      DESIGN_VERSIONS_CHANNELS,
      designVersionsDiscoverSchema,
    );

    const { objects: profileObjects } = useGraffitiDiscover(
      PROFILES_CHANNELS,
      profileSchema,
    );

    const profileIndex = computed(() =>
      profileIndexFromObjects(profileObjects.value),
    );

    const designVersionsForChat = computed(() =>
      mergeDesignVersions(
        designVersionRawObjects.value.filter(
          (o) => o.value?.chatId === props.chatId,
        ),
      ),
    );

    const designVersionCount = computed(() => designVersionsForChat.value.length);

    /** Local optimistic rows until Graffiti discover echoes the same messageId. */
    const optimisticMessages = ref([]);

    watch(
      () => objects.value,
      () => {
        const have = new Set();
        for (const o of objects.value) {
          const v = o.value;
          if (
            v?.type === "send_message" &&
            v.chatId === props.chatId &&
            v.messageId
          ) {
            have.add(v.messageId);
          }
        }
        if (!optimisticMessages.value.length) return;
        optimisticMessages.value = optimisticMessages.value.filter(
          (o) => !have.has(o.value.messageId),
        );
      },
      { deep: true },
    );

    const thread = computed(() => {
      if (!canAccessChat(chatMeta.value, session.value?.actor)) {
        return [];
      }
      const hidden = hiddenLocalMessageIds.value;
      const fromNet = objects.value
        .filter(
          (o) =>
            o.value?.type === "send_message" &&
            o.value?.chatId === props.chatId,
        )
        .filter((o) => !hidden.has(o.value.messageId));
      const byId = new Map();
      for (const o of fromNet) {
        const mid = o.value?.messageId;
        if (mid) byId.set(mid, o);
      }
      for (const o of optimisticMessages.value) {
        const mid = o.value?.messageId;
        if (
          mid &&
          !hidden.has(mid) &&
          !byId.has(mid) &&
          o.value?.chatId === props.chatId
        ) {
          byId.set(mid, o);
        }
      }
      return [...byId.values()].sort(
        (a, b) =>
          (a.value.createdAt ?? 0) - (b.value.createdAt ?? 0),
      );
    });

    const messageById = computed(() => {
      const m = new Map();
      for (const o of thread.value) {
        const id = o.value?.messageId;
        if (id) m.set(id, o);
      }
      return m;
    });

    const reactionsIndex = computed(() =>
      activeReactionsByMessageId(objects.value, props.chatId),
    );

    const pollVotesIndex = computed(() =>
      activePollVotesByMessageId(objects.value, props.chatId),
    );

    function pollVisualFor(m) {
      return pollVisualForMessage(
        m,
        pollVotesIndex.value,
        session.value?.actor,
      );
    }

    async function onPollVoteFromBubble(message, optionIndex) {
      const s = session.value;
      if (!s?.actor || !canViewChat.value) return;
      const mid = message.value?.messageId;
      if (mid == null) return;
      const opts = message.value?.poll?.options ?? [];
      if (
        typeof optionIndex !== "number" ||
        optionIndex < 0 ||
        optionIndex >= opts.length
      ) {
        return;
      }
      const prev = pollVotesIndex.value.get(mid)?.get(s.actor);
      error.value = "";
      const ok = await postPollVoteSelection({
        graffiti,
        session: s,
        chatId: props.chatId,
        messageId: mid,
        optionIndex,
        prevVote: prev
          ? { voteId: prev.voteId, optionIndex: prev.optionIndex }
          : null,
      });
      if (!ok) error.value = "Could not record vote.";
    }

    function resolveMessageObjectById(messageId) {
      if (!messageId) return null;
      const fromThread = messageById.value.get(messageId);
      if (fromThread) return fromThread;
      for (const o of objects.value) {
        const v = o.value;
        if (
          v?.type === "send_message" &&
          v.chatId === props.chatId &&
          v.messageId === messageId
        ) {
          return o;
        }
      }
      return null;
    }

    function replyQuoteFor(msgObj) {
      const rid = msgObj.value.replyToMessageId;
      if (!rid) return null;
      const parent = resolveMessageObjectById(rid);
      const label = parent
        ? displayUser(profileIndex.value, parent.value.createdBy)
        : "Message";
      const snippet = parent
        ? truncateSnippet(messagePreviewLabel(parent.value), 72)
        : "Original message not loaded.";
      return { senderLabel: label, snippet };
    }

    function reactionChipsForMessage(messageId) {
      return reactionChipRowsForMessage(
        messageId,
        reactionsIndex.value,
        session.value?.actor,
      );
    }

    const actorHandleCache = ref(new Map());

    async function resolveActorHandle(actor) {
      if (!actor) return;
      if (actorHandleCache.value.has(actor)) return;
      const g = graffiti;
      const fn = g?.actorToHandle;
      if (typeof fn !== "function") return;
      try {
        const h = await fn.call(g, actor);
        if (h != null && String(h).trim() !== "") {
          const next = new Map(actorHandleCache.value);
          next.set(actor, String(h).trim());
          actorHandleCache.value = next;
        }
      } catch {
        /* No verified handle — omit secondary line. */
      }
    }

    watch(
      () => [
        ...(chatMeta.value.members || []),
        session.value?.actor,
      ].filter(Boolean),
      (ids) => {
        const seen = new Set();
        for (const a of ids) {
          if (seen.has(a)) continue;
          seen.add(a);
          void resolveActorHandle(a);
        }
      },
      { immediate: true, flush: "post" },
    );

    function peerIdSecondaryLine(actor) {
      const handle = actorHandleCache.value.get(actor);
      if (handle) return handle;
      return shortOpaqueId(actor);
    }

    async function copyPeerLabel(label, text) {
      const ok = await copyTextToClipboard(text);
      if (!ok) {
        alert(label ? `Could not copy ${label}.` : "Could not copy.");
      }
    }

    const chatInfoSearchResults = computed(() => {
      const q = chatInfoSearchQuery.value.trim().toLowerCase();
      if (!q) return [];
      const out = [];
      for (const m of thread.value) {
        if (messageMatchesSearch(m, q)) {
          out.push(m);
          if (out.length >= 80) break;
        }
      }
      return out;
    });

    function closeActionsMenu() {
      openActionsMessageId.value = null;
    }

    function toggleActionsMenu(messageId) {
      openActionsMessageId.value =
        openActionsMessageId.value === messageId ? null : messageId;
    }

    function hideMessageLocally(msg) {
      const id = msg?.value?.messageId;
      if (id == null) return;
      const next = new Set(hiddenLocalMessageIds.value);
      next.add(id);
      hiddenLocalMessageIds.value = next;
      lastHiddenMessageIdForUndo.value = id;
      deleteUndoVisible.value = true;
      if (deleteUndoTimer != null) clearTimeout(deleteUndoTimer);
      deleteUndoTimer = window.setTimeout(() => {
        deleteUndoVisible.value = false;
        lastHiddenMessageIdForUndo.value = null;
        deleteUndoTimer = null;
      }, 12000);
    }

    function undoLastHiddenMessage() {
      const id = lastHiddenMessageIdForUndo.value;
      if (id == null) return;
      const next = new Set(hiddenLocalMessageIds.value);
      next.delete(id);
      hiddenLocalMessageIds.value = next;
      lastHiddenMessageIdForUndo.value = null;
      deleteUndoVisible.value = false;
      if (deleteUndoTimer != null) {
        clearTimeout(deleteUndoTimer);
        deleteUndoTimer = null;
      }
    }

    const deleteConfirmMessage = ref(null);
    const deleteUndoVisible = ref(false);
    const lastHiddenMessageIdForUndo = ref(null);
    let deleteUndoTimer = null;

    function onRequestDeleteMessage(msg) {
      deleteConfirmMessage.value = msg;
    }

    function cancelDeleteMessage() {
      deleteConfirmMessage.value = null;
    }

    function confirmDeleteMessage() {
      const msg = deleteConfirmMessage.value;
      deleteConfirmMessage.value = null;
      if (msg) hideMessageLocally(msg);
    }

    const replyDraft = ref(null);
    const composerTextareaRef = ref(null);

    function clearReplyDraft() {
      replyDraft.value = null;
    }

    function startReplyTo(msg) {
      replyDraft.value = {
        messageId: msg.value.messageId,
        senderLabel: displayUser(
          profileIndex.value,
          msg.value.createdBy,
        ),
        snippet: truncateSnippet(messagePreviewLabel(msg.value), 72),
      };
      nextTick(() => composerTextareaRef.value?.focus?.());
    }

    async function submitReactionToggle(message, emoji, myReactionId) {
      const s = session.value;
      if (!s?.actor || !canViewChat.value) return;
      error.value = "";
      try {
        if (myReactionId) {
          await graffiti.post(
            {
              value: {
                type: "remove_message_reaction",
                reactionId: myReactionId,
                chatId: props.chatId,
                messageId: message.value.messageId,
                removedAt: Date.now(),
                removedBy: s.actor,
              },
              channels: MESSAGES_CHANNELS,
            },
            s,
          );
        } else {
          await graffiti.post(
            {
              value: {
                type: "add_message_reaction",
                reactionId: crypto.randomUUID(),
                chatId: props.chatId,
                messageId: message.value.messageId,
                emoji,
                createdAt: Date.now(),
                createdBy: s.actor,
              },
              channels: MESSAGES_CHANNELS,
            },
            s,
          );
        }
      } catch (err) {
        console.error(err);
        error.value = "Could not update reaction.";
      }
    }

    function onReactionChipFromBubble(message, payload) {
      if (!payload || !session.value?.actor) return;
      void submitReactionToggle(
        message,
        payload.emoji,
        payload.myReactionId,
      );
    }

    const attachmentMenuOpen = ref(false);
    const fileInputEl = ref(null);
    const mediaInputEl = ref(null);
    const pollModalOpen = ref(false);
    const pollQuestion = ref("");
    const pollOptions = ref(["", ""]);
    const contactModalOpen = ref(false);
    const contactName = ref("");
    const contactDetail = ref("");

    function onUnifiedDocClick(e) {
      const aid = openActionsMessageId.value;
      if (aid != null) {
        const root = e.target.closest("[data-message-actions-root]");
        if (!root || root.getAttribute("data-message-actions-root") !== aid) {
          openActionsMessageId.value = null;
        }
      }
      if (attachmentMenuOpen.value) {
        const hit = e.target.closest("[data-composer-attachment-root]");
        if (!hit) attachmentMenuOpen.value = false;
      }
    }

    watch(
      () =>
        openActionsMessageId.value != null || attachmentMenuOpen.value,
      (active, _prev, onCleanup) => {
        if (!active) return;
        document.addEventListener("click", onUnifiedDocClick, false);
        onCleanup(() => {
          document.removeEventListener("click", onUnifiedDocClick, false);
        });
      },
    );

    onBeforeUnmount(() => {
      document.removeEventListener("click", onUnifiedDocClick, false);
    });

    const pinnedMessageIds = computed(() =>
      computePinnedMessageIds(pinChannelObjects.value, props.chatId),
    );

    async function onPinMessage(msg) {
      const s = session.value;
      if (!s?.actor || !canViewChat.value) return;
      if (pinnedMessageIds.value.has(msg.value.messageId)) return;
      try {
        await graffiti.post(
          {
            value: {
              type: "pin_message",
              pinId: crypto.randomUUID(),
              chatId: props.chatId,
              messageId: msg.value.messageId,
              pinnedAt: Date.now(),
              pinnedBy: s.actor,
            },
            channels: PINS_CHANNELS,
          },
          s,
        );
      } catch (e) {
        console.error(e);
      }
    }

    async function onUnpinMessage(msg) {
      const s = session.value;
      if (!s?.actor || !canViewChat.value) return;
      if (!pinnedMessageIds.value.has(msg.value.messageId)) return;
      try {
        await graffiti.post(
          {
            value: {
              type: "unpin_message",
              unpinId: crypto.randomUUID(),
              chatId: props.chatId,
              messageId: msg.value.messageId,
              unpinnedAt: Date.now(),
              unpinnedBy: s.actor,
            },
            channels: PINS_CHANNELS,
          },
          s,
        );
      } catch (e) {
        console.error(e);
      }
    }

    async function postSendMessage(valuePayload) {
      const s = session.value;
      if (!s?.actor) {
        error.value = "Log in to send messages.";
        return false;
      }
      if (!canViewChat.value) {
        error.value = "You do not have access to this chat.";
        return false;
      }
      busy.value = true;
      error.value = "";
      try {
        await graffiti.post(
          { value: valuePayload, channels: MESSAGES_CHANNELS },
          s,
        );
        return true;
      } catch (e) {
        console.error(e);
        error.value = "Message could not be sent.";
        return false;
      } finally {
        busy.value = false;
      }
    }

    const sendBtnPulse = ref(false);

    function pulseSendBtn() {
      sendBtnPulse.value = true;
      window.setTimeout(() => {
        sendBtnPulse.value = false;
      }, 280);
    }

    async function send() {
      const text = content.value.trim();
      if (!text) return;
      const s = session.value;
      if (!s?.actor) {
        error.value = "Log in to send messages.";
        return;
      }
      if (!canViewChat.value) {
        error.value = "You do not have access to this chat.";
        return;
      }
      const messageId = crypto.randomUUID();
      const now = Date.now();
      const replyTo = replyDraft.value;
      const ghost = {
        url: `urn:optimistic:${messageId}`,
        value: {
          type: "send_message",
          messageId,
          chatId: props.chatId,
          content: text,
          kind: "text",
          createdAt: now,
          createdBy: s.actor,
          ...(replyTo?.messageId
            ? { replyToMessageId: replyTo.messageId }
            : {}),
        },
      };
      optimisticMessages.value = [...optimisticMessages.value, ghost];
      content.value = "";
      replyDraft.value = null;
      error.value = "";
      nextTick(() => scrollMessagesToBottom());
      pulseSendBtn();
      busy.value = true;
      try {
        await graffiti.post(
          { value: ghost.value, channels: MESSAGES_CHANNELS },
          s,
        );
      } catch (e) {
        console.error(e);
        error.value = "Message could not be sent.";
        optimisticMessages.value = optimisticMessages.value.filter(
          (o) => o.value.messageId !== messageId,
        );
        content.value = text;
        if (replyTo?.messageId) {
          replyDraft.value = replyTo;
        }
      } finally {
        busy.value = false;
      }
    }

    function onComposerKeydown(e) {
      if (e.key !== "Enter") return;
      if (e.shiftKey || e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      send();
    }

    function toggleAttachmentMenu() {
      attachmentMenuOpen.value = !attachmentMenuOpen.value;
    }

    function pickFile() {
      attachmentMenuOpen.value = false;
      nextTick(() => fileInputEl.value?.click());
    }

    function pickMedia() {
      attachmentMenuOpen.value = false;
      nextTick(() => mediaInputEl.value?.click());
    }

    function openPollModal() {
      attachmentMenuOpen.value = false;
      pollQuestion.value = "";
      pollOptions.value = ["", ""];
      pollModalOpen.value = true;
    }

    function openContactModal() {
      attachmentMenuOpen.value = false;
      contactName.value = "";
      contactDetail.value = "";
      contactModalOpen.value = true;
    }

    function addPollOption() {
      pollOptions.value = [...pollOptions.value, ""];
    }

    async function onFileInput(e) {
      const input = e.target;
      const file = input.files?.[0];
      input.value = "";
      if (!file) return;
      if (file.size > MAX_ATTACHMENT_BYTES) {
        error.value = "File is too large (max 2 MB).";
        return;
      }
      const s = session.value;
      if (!s?.actor) return;
      if (!canViewChat.value) {
        error.value = "You do not have access to this chat.";
        return;
      }
      busy.value = true;
      error.value = "";
      try {
        const fileDataUrl = await readFileAsDataUrl(file);
        await graffiti.post(
          {
            value: {
              type: "send_message",
              messageId: crypto.randomUUID(),
              chatId: props.chatId,
              content: file.name,
              kind: "file",
              fileName: file.name,
              fileType: file.type || "application/octet-stream",
              fileSize: file.size,
              fileDataUrl,
              createdAt: Date.now(),
              createdBy: s.actor,
            },
            channels: MESSAGES_CHANNELS,
          },
          s,
        );
      } catch (err) {
        console.error(err);
        error.value = "Message could not be sent.";
      } finally {
        busy.value = false;
      }
    }

    async function onMediaInput(e) {
      const input = e.target;
      const file = input.files?.[0];
      input.value = "";
      if (!file) return;
      if (file.size > MAX_ATTACHMENT_BYTES) {
        error.value = "Photos/videos must be under 2 MB.";
        return;
      }
      const s = session.value;
      if (!s?.actor) return;
      if (!canViewChat.value) {
        error.value = "You do not have access to this chat.";
        return;
      }
      busy.value = true;
      error.value = "";
      try {
        const fileDataUrl = await readFileAsDataUrl(file);
        await graffiti.post(
          {
            value: {
              type: "send_message",
              messageId: crypto.randomUUID(),
              chatId: props.chatId,
              content: file.name,
              kind: "media",
              fileName: file.name,
              fileType: file.type || "application/octet-stream",
              fileSize: file.size,
              fileDataUrl,
              createdAt: Date.now(),
              createdBy: s.actor,
            },
            channels: MESSAGES_CHANNELS,
          },
          s,
        );
      } catch (err) {
        console.error(err);
        error.value = "Message could not be sent.";
      } finally {
        busy.value = false;
      }
    }

    async function submitPoll() {
      const q = pollQuestion.value.trim();
      const opts = pollOptions.value.map((o) => o.trim()).filter(Boolean);
      if (!q) {
        error.value = "Enter a poll question.";
        return;
      }
      if (opts.length < 2) {
        error.value = "Add at least two options.";
        return;
      }
      const s = session.value;
      if (!s?.actor) return;
      const ok = await postSendMessage({
        type: "send_message",
        messageId: crypto.randomUUID(),
        chatId: props.chatId,
        content: q,
        kind: "poll",
        poll: { question: q, options: opts },
        createdAt: Date.now(),
        createdBy: s.actor,
      });
      if (ok) pollModalOpen.value = false;
    }

    async function submitContact() {
      const name = contactName.value.trim();
      const detail = contactDetail.value.trim();
      if (!name) {
        error.value = "Enter a contact name.";
        return;
      }
      const s = session.value;
      if (!s?.actor) return;
      const ok = await postSendMessage({
        type: "send_message",
        messageId: crypto.randomUUID(),
        chatId: props.chatId,
        content: name,
        kind: "contact",
        contact: { name, detail },
        createdAt: Date.now(),
        createdBy: s.actor,
      });
      if (ok) contactModalOpen.value = false;
    }

    const headerInitial = computed(() => {
      const n = chatName.value;
      if (typeof n === "string" && n.length > 0) {
        return n.slice(0, 1).toUpperCase();
      }
      const id = props.chatId;
      return (id && id[0] ? id[0] : "?").toUpperCase();
    });

    function senderLabel(actor) {
      return displayUser(profileIndex.value, actor);
    }

    function bubbleAvatar(actor) {
      return displayAvatar(profileIndex.value, actor);
    }

    const chatMessagesRef = ref(null);

    const SCROLL_BOTTOM_THRESHOLD_PX = 80;

    function isMessagesNearBottom(el) {
      if (!el) return true;
      return (
        el.scrollHeight - el.scrollTop - el.clientHeight <=
        SCROLL_BOTTOM_THRESHOLD_PX
      );
    }

    function scrollMessagesToBottom() {
      nextTick(() => {
        const el = chatMessagesRef.value;
        if (el) el.scrollTop = el.scrollHeight;
      });
    }

    let lastAutoScrollChatId = props.chatId;

    watch(
      [
        thread,
        isFirstPoll,
        () => props.chatId,
        canViewChat,
        () => session.value?.actor,
      ],
      () => {
        const el = chatMessagesRef.value;
        const cid = props.chatId;
        if (cid !== lastAutoScrollChatId) {
          lastAutoScrollChatId = cid;
          scrollMessagesToBottom();
        } else if (isMessagesNearBottom(el)) {
          scrollMessagesToBottom();
        }
        const actor = session.value?.actor;
        if (!actor || !canViewChat.value || isFirstPoll.value) return;
        let maxAt = 0;
        for (const o of thread.value) {
          const v = o.value;
          if (v?.type === "send_message") {
            const t = v.createdAt ?? 0;
            if (t > maxAt) maxAt = t;
          }
        }
        markChatReadUpTo(props.chatId, maxAt, actor);
      },
      { deep: true, flush: "post" },
    );

    onMounted(() => {
      scrollMessagesToBottom();
    });

    const inviteBusy = ref(false);
    const inviteError = ref("");

    const inviteUrlDisplay = computed(() => {
      if (!chatMeta.value.inviteLinkEnabled || !chatMeta.value.inviteToken) {
        return "";
      }
      return buildStudioInviteUrl(props.chatId, chatMeta.value.inviteToken);
    });

    async function postInviteSettings(buildPayload) {
      const s = session.value;
      if (!s?.actor || !canManageMembers.value) return;
      inviteBusy.value = true;
      inviteError.value = "";
      try {
        await graffiti.post(
          {
            value: buildPayload(s.actor),
            channels: CHATS_CHANNELS,
          },
          s,
        );
      } catch (e) {
        console.error(e);
        inviteError.value = "Could not update invite link.";
      } finally {
        inviteBusy.value = false;
      }
    }

    function enableInviteLink() {
      return postInviteSettings((actor) => ({
        type: "set_chat_invite",
        chatId: props.chatId,
        inviteToken: crypto.randomUUID(),
        disabled: false,
        updatedAt: Date.now(),
        updatedBy: actor,
      }));
    }

    function rotateInviteLink() {
      return enableInviteLink();
    }

    function disableInviteLink() {
      return postInviteSettings((actor) => ({
        type: "set_chat_invite",
        chatId: props.chatId,
        inviteToken: "",
        disabled: true,
        updatedAt: Date.now(),
        updatedBy: actor,
      }));
    }

    async function copyInviteLink() {
      inviteError.value = "";
      const url = inviteUrlDisplay.value;
      if (!url) return;
      const ok = await copyTextToClipboard(url);
      if (!ok) {
        inviteError.value = "Could not copy link.";
      }
    }

    return {
      session,
      content,
      busy,
      error,
      chatMeta,
      chatName,
      headerPhotoUrl,
      headerInitial,
      thread,
      chatMessagesRef,
      isFirstPoll,
      pinnedMessageIds,
      send,
      onComposerKeydown,
      onPinMessage,
      onUnpinMessage,
      senderLabel,
      bubbleAvatar,
      openActionsMessageId,
      toggleActionsMenu,
      closeActionsMenu,
      onRequestDeleteMessage,
      cancelDeleteMessage,
      confirmDeleteMessage,
      deleteConfirmMessage,
      undoLastHiddenMessage,
      deleteUndoVisible,
      replyDraft,
      clearReplyDraft,
      startReplyTo,
      composerTextareaRef,
      replyQuoteFor,
      reactionChipsForMessage,
      onReactionChipFromBubble,
      pollVisualFor,
      onPollVoteFromBubble,
      attachmentMenuOpen,
      toggleAttachmentMenu,
      fileInputEl,
      mediaInputEl,
      onFileInput,
      onMediaInput,
      pickFile,
      pickMedia,
      pollModalOpen,
      pollQuestion,
      pollOptions,
      openPollModal,
      addPollOption,
      submitPoll,
      contactModalOpen,
      contactName,
      contactDetail,
      openContactModal,
      submitContact,
      chatInfoOpen,
      openChatInfo,
      closeChatInfo,
      editChatName,
      editPhotoUrl,
      newMemberActor,
      saveChatProfile,
      submitAddChatMember,
      chatInfoSearchQuery,
      chatInfoSearchResults,
      chatInfoSnippet,
      formatMsgInfoTime,
      onChatInfoSearchPick,
      chatInfoBusy,
      chatInfoError,
      designVersionCount,
      sendBtnPulse,
      peerIdSecondaryLine,
      copyPeerLabel,
      canViewChat,
      canManageMembers,
      showChatAccessDenied,
      showChatAccessLoading,
      isFirstChatPoll,
      inviteBusy,
      inviteError,
      inviteUrlDisplay,
      enableInviteLink,
      rotateInviteLink,
      disableInviteLink,
      copyInviteLink,
      openUserProfile,
    };
  },
  template: `
    <div class="chat-room">
      <header class="chat-header">
        <div class="chat-header-brand">
          <button
            type="button"
            class="chat-header-trigger"
            aria-label="Open chat info"
            :disabled="session === null || !canViewChat"
            @click="session?.actor && canViewChat && openChatInfo()"
          >
            <div class="chat-header-avatar-slot">
              <img
                v-if="headerPhotoUrl"
                :src="headerPhotoUrl"
                alt=""
                class="chat-header-avatar chat-header-avatar--img"
              />
              <div v-else class="chat-header-avatar" aria-hidden="true">{{ headerInitial }}</div>
            </div>
            <div class="chat-header-text">
              <h2 class="chat-header-title">{{ chatName || 'Chat' }}</h2>
            </div>
          </button>
          <p v-if="session === null" class="chat-header-sub chat-header-sub--gate chat-header-sub--below">Sign in to view this room</p>
          <p v-else-if="showChatAccessDenied" class="chat-header-sub chat-header-sub--gate chat-header-sub--below">No access</p>
          <p v-else-if="!(session?.actor && canViewChat)" class="chat-header-sub chat-header-sub--below">Loading…</p>
        </div>
        <div class="chat-header-main">
          <nav class="chat-header-tabs" aria-label="Chat views">
            <router-link :to="'/chat/' + chatId" class="chat-header-tab" active-class="is-active">
              Chat
            </router-link>
            <router-link :to="'/chat/' + chatId + '/pins'" class="chat-header-tab" active-class="is-active">
              Pinned
            </router-link>
          </nav>
        </div>
      </header>

      <div v-if="session === null" class="chat-login-gate">
        <p class="chat-login-gate-title">Log in to view this chat.</p>
        <p class="chat-login-gate-text">Message history and room details stay private until you sign in from the sidebar.</p>
      </div>

      <div v-else-if="session === undefined" class="chat-login-gate chat-login-gate--tight">
        <p class="chat-login-gate-title">Loading…</p>
      </div>

      <div v-else-if="showChatAccessLoading" class="chat-login-gate chat-login-gate--tight">
        <p class="chat-login-gate-title">Loading chat…</p>
      </div>

      <div v-else-if="showChatAccessDenied" class="chat-login-gate chat-access-denied">
        <p class="chat-login-gate-title">You do not have access to this chat.</p>
        <p class="chat-login-gate-text">Ask the creator to add your member ID, or pick a room from your sidebar.</p>
      </div>

      <template v-else-if="canViewChat && session?.actor">
      <router-link
        :to="'/chat/' + chatId + '/versions'"
        class="design-versions-entry"
      >
        <span class="design-versions-entry-lead">
          <span class="design-versions-entry-icon-wrap" aria-hidden="true">
            <svg class="design-versions-entry-icon" width="22" height="22" viewBox="0 0 24 24" fill="none">
              <rect x="3" y="12" width="14" height="9" rx="1.5" stroke="currentColor" stroke-width="1.6"/>
              <rect x="6" y="7" width="14" height="9" rx="1.5" stroke="currentColor" stroke-width="1.6"/>
              <rect x="9" y="2" width="14" height="9" rx="1.5" stroke="currentColor" stroke-width="1.6"/>
            </svg>
          </span>
          <span class="design-versions-entry-copy">
            <span class="design-versions-entry-label">Design Versions</span>
            <span class="design-versions-entry-sub">{{ designVersionCount }} in this room</span>
          </span>
        </span>
        <span class="design-versions-entry-tail" aria-hidden="true">
          <span class="design-versions-entry-pill">{{ designVersionCount }}</span>
          <svg class="design-versions-entry-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </span>
      </router-link>

      <div class="chat-messages-wrap">
        <p v-if="isFirstPoll && thread.length === 0" class="chat-messages-status">Loading messages…</p>
        <p v-else-if="thread.length === 0" class="chat-messages-status">No messages yet. Say hello below.</p>
        <div v-else ref="chatMessagesRef" class="chat-messages">
          <div
            v-for="m in thread"
            :key="m.url"
            class="message-row"
            :class="[
              session?.actor === m.value.createdBy ? 'message-row--own' : 'message-row--other',
              { 'message-row--menu-open': openActionsMessageId === m.value.messageId },
            ]"
          >
            <MessageBubble
              :message="m"
              :is-own="session?.actor === m.value.createdBy"
              :is-pinned="pinnedMessageIds.has(m.value.messageId)"
              :can-act="!!session?.actor"
              :sender-label="senderLabel(m.value.createdBy)"
              :avatar-photo-url="bubbleAvatar(m.value.createdBy).photoUrl"
              :avatar-initial="bubbleAvatar(m.value.createdBy).initial"
              :actions-menu-open="openActionsMessageId === m.value.messageId"
              :reply-quote="replyQuoteFor(m)"
              :reaction-chips="reactionChipsForMessage(m.value.messageId)"
              :session-actor="session.actor"
              :poll-visual="pollVisualFor(m)"
              @toggle-actions-menu="toggleActionsMenu(m.value.messageId)"
              @close-actions-menu="closeActionsMenu"
              @pin="onPinMessage"
              @unpin="onUnpinMessage"
              @request-delete="onRequestDeleteMessage"
              @reply="startReplyTo"
              @reaction-chip="onReactionChipFromBubble(m, $event)"
              @poll-vote="onPollVoteFromBubble(m, $event)"
            />
          </div>
        </div>
      </div>

      <footer class="chat-composer">
        <p v-if="session === undefined" class="composer-hint">Loading session…</p>
        <template v-else-if="session?.actor">
          <div v-if="deleteUndoVisible" class="delete-undo-toast" role="status">
            <span>Message hidden on this device.</span>
            <button type="button" class="btn btn-ghost btn-sm delete-undo-btn" @click="undoLastHiddenMessage">
              Undo
            </button>
          </div>
          <div v-if="replyDraft" class="composer-reply-preview">
            <div class="composer-reply-preview-body">
              <span class="composer-reply-preview-label">Replying to {{ replyDraft.senderLabel }}</span>
              <p class="composer-reply-preview-snippet">{{ replyDraft.snippet }}</p>
            </div>
            <button type="button" class="btn btn-ghost composer-reply-preview-dismiss" aria-label="Cancel reply" @click="clearReplyDraft">
              ×
            </button>
          </div>
          <div class="composer-inner">
            <div class="composer-attach-col" data-composer-attachment-root>
              <button
                type="button"
                class="composer-attach-btn"
                :class="{ 'composer-attach-btn--open': attachmentMenuOpen }"
                aria-label="Attachments"
                :aria-expanded="attachmentMenuOpen"
                @click.stop="toggleAttachmentMenu"
              >
                <svg class="composer-attach-plus" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.25"
                    stroke-linecap="round"
                    d="M12 5v14M5 12h14"
                  />
                </svg>
              </button>
              <div
                v-show="attachmentMenuOpen"
                class="composer-attach-menu"
                role="menu"
                aria-label="Attachment options"
                @click.stop
              >
                <p class="composer-attach-menu-head">Attach</p>
                <button type="button" class="composer-attach-row" role="menuitem" @click="pickFile">
                  <span class="composer-attach-icon-wrap composer-attach-icon-wrap--file" aria-hidden="true">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
                      <path d="M14 2v6h6" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
                      <path d="M8 13h8M8 17h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
                    </svg>
                  </span>
                  <span class="composer-attach-label">File</span>
                </button>
                <button type="button" class="composer-attach-row" role="menuitem" @click="pickMedia">
                  <span class="composer-attach-icon-wrap composer-attach-icon-wrap--media" aria-hidden="true">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                      <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="1.6"/>
                      <circle cx="8.5" cy="10" r="1.5" fill="currentColor"/>
                      <path d="M21 15l-5-5-4 4-2-2-5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                  </span>
                  <span class="composer-attach-label">Photos &amp; videos</span>
                </button>
                <button type="button" class="composer-attach-row" role="menuitem" @click="openPollModal">
                  <span class="composer-attach-icon-wrap composer-attach-icon-wrap--poll" aria-hidden="true">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                      <path d="M4 19V5M4 19h16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
                      <path d="M8 16V10M12 16V7M16 16v-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
                    </svg>
                  </span>
                  <span class="composer-attach-label">Poll</span>
                </button>
                <button type="button" class="composer-attach-row" role="menuitem" @click="openContactModal">
                  <span class="composer-attach-icon-wrap composer-attach-icon-wrap--contact" aria-hidden="true">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="8" r="3.2" stroke="currentColor" stroke-width="1.6"/>
                      <path d="M5 20v-1a7 7 0 0 1 14 0v1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
                    </svg>
                  </span>
                  <span class="composer-attach-label">Contact</span>
                </button>
              </div>
              <input
                ref="fileInputEl"
                type="file"
                class="visually-hidden"
                tabindex="-1"
                @change="onFileInput"
              />
              <input
                ref="mediaInputEl"
                type="file"
                accept="image/*,video/*"
                class="visually-hidden"
                tabindex="-1"
                @change="onMediaInput"
              />
            </div>
            <form class="composer-form" @submit.prevent="send">
              <textarea
                ref="composerTextareaRef"
                v-model="content"
                class="composer-input"
                placeholder="Type a message"
                aria-label="Message"
                rows="1"
                @keydown="onComposerKeydown"
              ></textarea>
              <button
                type="submit"
                :class="['composer-send', 'btn', 'btn-primary', { 'btn-action-feedback': sendBtnPulse }]"
                :disabled="busy"
              >
                {{ busy ? '…' : 'Send' }}
              </button>
            </form>
          </div>
          <p v-if="error" class="composer-error">{{ error }}</p>
        </template>
      </footer>

      <div
        v-if="pollModalOpen"
        class="composer-modal-overlay"
        role="presentation"
        @click.self="pollModalOpen = false"
      >
        <div class="composer-modal" role="dialog" aria-labelledby="poll-modal-title">
          <h3 id="poll-modal-title" class="composer-modal-title">New poll</h3>
          <label class="composer-modal-label">
            Question
            <input v-model="pollQuestion" type="text" class="composer-modal-input" placeholder="Ask a question" />
          </label>
          <div class="composer-modal-label">Options</div>
          <input
            v-for="(opt, idx) in pollOptions"
            :key="'po-' + idx"
            v-model="pollOptions[idx]"
            type="text"
            class="composer-modal-input composer-modal-input--opt"
            :placeholder="'Option ' + (idx + 1)"
          />
          <button type="button" class="btn btn-ghost composer-modal-add" @click="addPollOption">
            + Add option
          </button>
          <div class="composer-modal-actions">
            <button type="button" class="btn btn-ghost" @click="pollModalOpen = false">Cancel</button>
            <button type="button" class="btn btn-primary" :disabled="busy" @click="submitPoll">Send poll</button>
          </div>
        </div>
      </div>

      <div
        v-if="contactModalOpen"
        class="composer-modal-overlay"
        role="presentation"
        @click.self="contactModalOpen = false"
      >
        <div class="composer-modal" role="dialog" aria-labelledby="contact-modal-title">
          <h3 id="contact-modal-title" class="composer-modal-title">Share contact</h3>
          <label class="composer-modal-label">
            Name
            <input v-model="contactName" type="text" class="composer-modal-input" placeholder="Name" />
          </label>
          <label class="composer-modal-label">
            Phone, email, or notes
            <textarea v-model="contactDetail" class="composer-modal-textarea" rows="3" placeholder="Details"></textarea>
          </label>
          <div class="composer-modal-actions">
            <button type="button" class="btn btn-ghost" @click="contactModalOpen = false">Cancel</button>
            <button type="button" class="btn btn-primary" :disabled="busy" @click="submitContact">Send</button>
          </div>
        </div>
      </div>

      <div
        v-if="deleteConfirmMessage"
        class="composer-modal-overlay"
        role="presentation"
        @click.self="cancelDeleteMessage"
      >
        <div class="composer-modal" role="alertdialog" aria-labelledby="delete-msg-title" aria-describedby="delete-msg-desc">
          <h3 id="delete-msg-title" class="composer-modal-title">Delete this message?</h3>
          <p id="delete-msg-desc" class="delete-confirm-desc">
            It will disappear from your view on <strong>this device only</strong>. Other people in the chat still see it. This app does not remove data from the network.
          </p>
          <p class="delete-confirm-desc delete-confirm-desc--muted">
            After you delete, you can tap <strong>Undo</strong> for a few seconds to bring it back here.
          </p>
          <div class="composer-modal-actions">
            <button type="button" class="btn btn-ghost" @click="cancelDeleteMessage">Cancel</button>
            <button type="button" class="btn btn-primary composer-modal-delete-confirm" @click="confirmDeleteMessage">
              Delete for me
            </button>
          </div>
        </div>
      </div>
      </template>

      <div v-else class="chat-login-gate chat-login-gate--tight">
        <p class="chat-login-gate-title">Loading…</p>
      </div>

      <div
        v-if="chatInfoOpen && session?.actor && canViewChat"
        class="chat-info-overlay"
        role="presentation"
        @click.self="closeChatInfo"
      >
        <div
          class="chat-info-panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="chat-info-title"
          @click.stop
        >
          <div class="chat-info-topbar">
            <h2 id="chat-info-title" class="chat-info-title">Chat info</h2>
            <button type="button" class="btn btn-ghost chat-info-done" @click="closeChatInfo">Done</button>
          </div>
          <div class="chat-info-body">
            <div class="chat-info-hero">
              <div class="chat-info-hero-avatar" aria-hidden="true">
                <img
                  v-if="chatMeta.photoUrl"
                  :src="chatMeta.photoUrl"
                  alt=""
                  class="chat-info-hero-img"
                />
                <div v-else class="chat-info-hero-fallback">{{ headerInitial }}</div>
              </div>
              <p class="chat-info-hero-name">{{ chatName }}</p>
              <p class="chat-info-hero-type">
                <span :class="['chat-info-badge', chatMeta.isGroup ? 'chat-info-badge--group' : '']">
                  {{ chatMeta.isGroup ? 'Group' : 'Direct' }}
                </span>
                <span class="chat-info-meta-line">{{ chatMeta.members.length }} member(s)</span>
              </p>
            </div>

            <section class="chat-info-section" aria-label="Details">
              <h3 class="chat-info-section-title">Details</h3>
              <div class="chat-info-row chat-info-row--wrap">
                <span class="chat-info-k">Room ID</span>
                <div class="chat-info-v-with-copy">
                  <code class="chat-info-v">{{ chatId }}</code>
                  <button type="button" class="btn-copy-id" title="Copy room ID" @click="copyPeerLabel('Room ID', chatId)">Copy</button>
                </div>
              </div>
              <div v-if="chatMeta.createdBy" class="chat-info-row">
                <span class="chat-info-k">Created by</span>
                <button
                  type="button"
                  class="chat-info-v chat-info-profile-link"
                  @click="openUserProfile(chatMeta.createdBy)"
                >
                  {{ senderLabel(chatMeta.createdBy) }}
                </button>
              </div>
            </section>

            <section v-if="session?.actor" class="chat-info-section" aria-label="Edit chat profile">
              <h3 class="chat-info-section-title">Name and photo</h3>
              <label class="chat-info-label">
                Chat name
                <input v-model="editChatName" type="text" class="chat-info-input" autocomplete="off" />
              </label>
              <label class="chat-info-label">
                Photo URL
                <input v-model="editPhotoUrl" type="url" class="chat-info-input" placeholder="https://…" autocomplete="off" />
              </label>
              <div class="chat-info-actions">
                <button
                  type="button"
                  class="btn btn-primary"
                  :disabled="chatInfoBusy"
                  @click="saveChatProfile"
                >
                  {{ chatInfoBusy ? '…' : 'Save' }}
                </button>
              </div>
            </section>
            <p v-else class="chat-info-hint">Log in to edit this chat’s name or photo.</p>
            <p v-if="chatInfoError" class="chat-info-error" role="alert">{{ chatInfoError }}</p>

            <section
              v-if="session?.actor && canManageMembers && canViewChat"
              class="chat-info-section"
              aria-label="Invite link"
            >
              <h3 class="chat-info-section-title">Invite link</h3>
              <p class="chat-info-muted chat-info-invite-intro">
                Anyone with the link can join after signing in. Rotate the link if it leaks.
                This is enforced in the app only — sharing channels means payloads may still be visible to other Graffiti clients without capability isolation or encryption.
              </p>
              <template v-if="chatMeta.inviteLinkEnabled">
                <div class="chat-info-invite-url-row">
                  <code class="chat-info-invite-url" title="Invite URL">{{ inviteUrlDisplay }}</code>
                  <button
                    type="button"
                    class="btn btn-primary btn-sm chat-info-invite-copy"
                    :disabled="inviteBusy"
                    @click="copyInviteLink"
                  >
                    Copy link
                  </button>
                </div>
                <div class="chat-info-invite-actions">
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm"
                    :disabled="inviteBusy"
                    @click="rotateInviteLink"
                  >
                    New link
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm"
                    :disabled="inviteBusy"
                    @click="disableInviteLink"
                  >
                    Disable
                  </button>
                </div>
              </template>
              <template v-else>
                <button
                  type="button"
                  class="btn btn-primary"
                  :disabled="inviteBusy"
                  @click="enableInviteLink"
                >
                  {{ inviteBusy ? '…' : 'Create invite link' }}
                </button>
              </template>
              <p v-if="inviteError" class="chat-info-error" role="alert">{{ inviteError }}</p>
            </section>

            <section class="chat-info-section" aria-label="Members">
              <h3 class="chat-info-section-title">Members</h3>
              <p class="chat-info-muted chat-info-join-hint">To add someone, paste their full member ID below (Copy from their profile).</p>
              <p class="chat-info-muted chat-info-invite-note">Only the creator can add members by ID or manage invite links.</p>
              <p v-if="chatMeta.members.length === 0" class="chat-info-muted">Members not available yet.</p>
              <ul v-else class="chat-info-member-list">
                <li
                  v-for="memberActor in chatMeta.members"
                  :key="memberActor"
                  class="chat-info-member-row"
                >
                  <button
                    type="button"
                    class="chat-info-member-hit"
                    @click="openUserProfile(memberActor)"
                  >
                    <div class="chat-info-member-ava">
                      <img
                        v-if="bubbleAvatar(memberActor).photoUrl"
                        :src="bubbleAvatar(memberActor).photoUrl"
                        alt=""
                        class="chat-info-member-img"
                      />
                      <span v-else class="chat-info-member-init">{{ bubbleAvatar(memberActor).initial }}</span>
                    </div>
                    <div class="chat-info-member-text">
                      <span class="chat-info-member-name">{{ senderLabel(memberActor) }}</span>
                      <span class="chat-info-member-idline">{{ peerIdSecondaryLine(memberActor) }}</span>
                    </div>
                  </button>
                  <div class="chat-info-member-raw-row">
                    <code class="chat-info-member-id">{{ memberActor }}</code>
                    <button
                      type="button"
                      class="btn-copy-id"
                      title="Copy member ID"
                      @click.stop="copyPeerLabel('Member ID', memberActor)"
                    >
                      Copy
                    </button>
                  </div>
                </li>
              </ul>
              <div
                v-if="chatMeta.members.length === 0 && session?.actor"
                class="chat-info-you-wrap"
              >
                <button
                  type="button"
                  class="chat-info-you-hit"
                  @click="openUserProfile(session.actor)"
                >
                  <span class="chat-info-label-inline">You</span>
                  {{ senderLabel(session.actor) }}
                </button>
                <div class="chat-info-member-raw-row chat-info-member-raw-row--you">
                  <code class="chat-info-member-id">{{ session.actor }}</code>
                  <button
                    type="button"
                    class="btn-copy-id"
                    title="Copy your member ID"
                    @click="copyPeerLabel('Your member ID', session.actor)"
                  >
                    Copy
                  </button>
                </div>
              </div>
              <div v-if="session?.actor && canManageMembers" class="chat-info-add-row">
                <input
                  v-model="newMemberActor"
                  type="text"
                  class="chat-info-input chat-info-input--inline"
                  placeholder="Paste member ID to add"
                  autocomplete="off"
                />
                <button
                  type="button"
                  class="btn btn-primary"
                  :disabled="chatInfoBusy"
                  @click="submitAddChatMember"
                >
                  Add
                </button>
              </div>
              <p v-else-if="session?.actor && !canManageMembers" class="chat-info-hint">Only the creator can add people to this chat.</p>
              <p v-else class="chat-info-hint">Log in to add members.</p>
            </section>

            <section class="chat-info-section" aria-label="Search in chat">
              <h3 class="chat-info-section-title">Search messages in this chat</h3>
              <input
                v-model="chatInfoSearchQuery"
                type="search"
                class="chat-info-input"
                placeholder="Search messages in this chat"
                autocomplete="off"
              />
              <ul v-if="chatInfoSearchQuery.trim() && chatInfoSearchResults.length" class="chat-info-search-list">
                <li
                  v-for="row in chatInfoSearchResults"
                  :key="row.url"
                  class="chat-info-search-row"
                >
                  <button type="button" class="chat-info-search-hit" @click="onChatInfoSearchPick">
                    <span class="chat-info-search-from">{{ senderLabel(row.value.createdBy) }}</span>
                    <span class="chat-info-search-snippet">{{ chatInfoSnippet(row) }}</span>
                    <span class="chat-info-search-time">{{ formatMsgInfoTime(row.value.createdAt) }}</span>
                  </button>
                </li>
              </ul>
              <p
                v-else-if="chatInfoSearchQuery.trim()"
                class="chat-info-muted"
              >
                No messages match.
              </p>
            </section>
          </div>
        </div>
      </div>
    </div>
  `,
});

const PinnedMessagesView = defineComponent({
  name: "PinnedMessagesView",
  components: { MessageBubble },
  props: {
    chatId: { type: String, required: true },
  },
  setup(props) {
    const session = useGraffitiSession();
    const graffiti = useGraffiti();
    const search = ref("");
    const sortOrder = ref("newest");

    const { objects: chatObjects, isFirstPoll: isFirstChatPoll } = useGraffitiDiscover(
      CHATS_CHANNELS,
      chatsChannelSchema,
    );

    const chatMeta = computed(() =>
      mergeChatMeta(props.chatId, chatObjects.value),
    );
    const chatName = computed(() => chatMeta.value.name || "Chat");
    const headerPhotoUrl = computed(() => chatMeta.value.photoUrl || "");

    const canViewChat = computed(() =>
      canAccessChat(chatMeta.value, session.value?.actor),
    );

    const showChatAccessDenied = computed(() => {
      const actor = session.value?.actor;
      if (!actor) return false;
      if (isFirstChatPoll.value) return false;
      return !canAccessChat(chatMeta.value, actor);
    });

    const showChatAccessLoading = computed(
      () => !!session.value?.actor && isFirstChatPoll.value,
    );

    const { objects: messageObjects } = useGraffitiDiscover(
      MESSAGES_CHANNELS,
      messagesChannelSchema,
    );

    const { objects: pinChannelObjects } = useGraffitiDiscover(
      PINS_CHANNELS,
      pinsDiscoverSchema,
    );

    const { objects: profileObjects } = useGraffitiDiscover(
      PROFILES_CHANNELS,
      profileSchema,
    );

    const profileIndex = computed(() =>
      profileIndexFromObjects(profileObjects.value),
    );

    const messageById = computed(() => {
      const m = new Map();
      for (const o of messageObjects.value) {
        const v = o.value;
        if (v?.type === "send_message" && v.chatId === props.chatId) {
          m.set(v.messageId, o);
        }
      }
      return m;
    });

    const pinnedMessageIds = computed(() =>
      computePinnedMessageIds(pinChannelObjects.value, props.chatId),
    );

    const pollVotesIndex = computed(() =>
      activePollVotesByMessageId(messageObjects.value, props.chatId),
    );

    function pollVisualForPinned(m) {
      return pollVisualForMessage(
        m,
        pollVotesIndex.value,
        session.value?.actor,
      );
    }

    async function onPollVoteFromBubblePinned(message, optionIndex) {
      const s = session.value;
      if (!s?.actor || !canViewChat.value) return;
      const mid = message.value?.messageId;
      if (mid == null) return;
      const opts = message.value?.poll?.options ?? [];
      if (
        typeof optionIndex !== "number" ||
        optionIndex < 0 ||
        optionIndex >= opts.length
      ) {
        return;
      }
      const prev = pollVotesIndex.value.get(mid)?.get(s.actor);
      await postPollVoteSelection({
        graffiti,
        session: s,
        chatId: props.chatId,
        messageId: mid,
        optionIndex,
        prevVote: prev
          ? { voteId: prev.voteId, optionIndex: prev.optionIndex }
          : null,
      });
    }

    const rawPinnedRows = computed(() => {
      if (!canAccessChat(chatMeta.value, session.value?.actor)) {
        return [];
      }
      const rows = [];
      for (const mid of pinnedMessageIds.value) {
        let bestPin = null;
        let bestAt = -1;
        for (const o of pinChannelObjects.value) {
          const v = o.value;
          if (
            v?.type === "pin_message" &&
            v.chatId === props.chatId &&
            v.messageId === mid
          ) {
            const t = v.pinnedAt ?? 0;
            if (t >= bestAt) {
              bestAt = t;
              bestPin = o;
            }
          }
        }
        if (!bestPin) continue;
        rows.push({
          messageId: mid,
          message: messageById.value.get(mid) ?? null,
          pin: bestPin,
        });
      }
      return rows;
    });

    const filteredSortedRows = computed(() => {
      let list = rawPinnedRows.value;
      const q = search.value.trim().toLowerCase();
      if (q) {
        list = list.filter((row) => {
          if (!row.message) return false;
          return messageMatchesSearch(row.message, q);
        });
      }
      const mult = sortOrder.value === "newest" ? -1 : 1;
      return [...list].sort(
        (a, b) =>
          mult *
          ((a.pin.value.pinnedAt ?? 0) - (b.pin.value.pinnedAt ?? 0)),
      );
    });

    const headerInitial = computed(() => {
      const n = chatName.value;
      if (typeof n === "string" && n.length > 0) {
        return n.slice(0, 1).toUpperCase();
      }
      return (props.chatId && props.chatId[0] ? props.chatId[0] : "?").toUpperCase();
    });

    function senderLabel(actor) {
      return displayUser(profileIndex.value, actor);
    }

    function bubbleAvatar(actor) {
      return displayAvatar(profileIndex.value, actor);
    }

    function formatDateTime(ts) {
      if (ts == null) return "—";
      try {
        return new Date(ts).toLocaleString(undefined, {
          dateStyle: "short",
          timeStyle: "short",
        });
      } catch {
        return "—";
      }
    }

    async function unpinRow(row) {
      const s = session.value;
      if (!s?.actor || !canViewChat.value) return;
      try {
        await graffiti.post(
          {
            value: {
              type: "unpin_message",
              unpinId: crypto.randomUUID(),
              chatId: props.chatId,
              messageId: row.messageId,
              unpinnedAt: Date.now(),
              unpinnedBy: s.actor,
            },
            channels: PINS_CHANNELS,
          },
          s,
        );
      } catch (e) {
        console.error(e);
      }
    }

    function labelFor(actor) {
      return displayUser(profileIndex.value, actor);
    }

    function pinnedByline(row) {
      return `Pinned by ${labelFor(row.pin.value.pinnedBy)} · ${formatDateTime(row.pin.value.pinnedAt)}`;
    }

    return {
      session,
      chatName,
      headerPhotoUrl,
      headerInitial,
      search,
      sortOrder,
      rawPinnedRows,
      filteredSortedRows,
      formatDateTime,
      labelFor,
      senderLabel,
      bubbleAvatar,
      pinnedByline,
      unpinRow,
      pollVisualForPinned,
      onPollVoteFromBubblePinned,
      canViewChat,
      showChatAccessDenied,
      showChatAccessLoading,
    };
  },
  template: `
    <div class="chat-room chat-room--pins-only">
      <header class="chat-header">
        <router-link class="chat-header-trigger" :to="'/chat/' + chatId">
          <div class="chat-header-avatar-slot">
            <img
              v-if="headerPhotoUrl"
              :src="headerPhotoUrl"
              alt=""
              class="chat-header-avatar chat-header-avatar--img"
            />
            <div v-else class="chat-header-avatar" aria-hidden="true">{{ headerInitial }}</div>
          </div>
          <div class="chat-header-text">
            <h2 class="chat-header-title">{{ chatName || 'Chat' }}</h2>
            <p v-if="session?.actor && canViewChat" class="chat-header-sub">Pinned · Room <code>{{ chatId }}</code></p>
            <p v-else-if="session === null" class="chat-header-sub chat-header-sub--gate">Sign in to view pins</p>
            <p v-else-if="showChatAccessDenied" class="chat-header-sub chat-header-sub--gate">No access</p>
            <p v-else class="chat-header-sub">Loading…</p>
          </div>
        </router-link>
        <div class="chat-header-main">
          <nav class="chat-header-tabs" aria-label="Chat views">
            <router-link :to="'/chat/' + chatId" class="chat-header-tab" active-class="is-active">
              Chat
            </router-link>
            <router-link :to="'/chat/' + chatId + '/pins'" class="chat-header-tab" active-class="is-active">
              Pinned
            </router-link>
          </nav>
        </div>
      </header>

      <div v-if="session === null" class="chat-login-gate">
        <p class="chat-login-gate-title">Log in to view this chat.</p>
        <p class="chat-login-gate-text">Pinned messages stay private until you sign in from the sidebar.</p>
      </div>

      <div v-else-if="session === undefined" class="chat-login-gate chat-login-gate--tight">
        <p class="chat-login-gate-title">Loading…</p>
      </div>

      <div v-else-if="showChatAccessLoading" class="chat-login-gate chat-login-gate--tight">
        <p class="chat-login-gate-title">Loading chat…</p>
      </div>

      <div v-else-if="showChatAccessDenied" class="chat-login-gate chat-access-denied">
        <p class="chat-login-gate-title">You do not have access to this chat.</p>
        <p class="chat-login-gate-text">Ask the creator to add your member ID, or pick a room from your sidebar.</p>
      </div>

      <template v-else-if="canViewChat && session?.actor">
      <div class="pinned-manager-toolbar">
        <label class="pinned-search-label">
          <span class="visually-hidden">Search pinned</span>
          <input
            v-model="search"
            type="search"
            class="pinned-search-input"
            placeholder="Search pinned messages"
            autocomplete="off"
          />
        </label>
        <div class="pinned-sort">
          <label for="pin-sort">Sort</label>
          <select id="pin-sort" v-model="sortOrder" class="pinned-sort-select">
            <option value="newest">Newest pinned first</option>
            <option value="oldest">Oldest pinned first</option>
          </select>
        </div>
      </div>

      <div class="pinned-manager-body">
        <p v-if="rawPinnedRows.length === 0" class="pinned-manager-empty">
          No pinned messages yet. Pin messages from the chat using the ⋯ menu on each bubble.
        </p>
        <p v-else-if="filteredSortedRows.length === 0" class="pinned-manager-empty">
          No pinned messages match your search.
        </p>
        <ul v-else class="pinned-thread-list">
          <li
            v-for="row in filteredSortedRows"
            :key="row.messageId + '-' + (row.pin.url || row.pin.value.pinId)"
            :class="[
              'pinned-thread-item',
              row.message && session?.actor === row.message.value.createdBy ? 'pinned-thread-item--own' : '',
            ]"
          >
            <div
              v-if="row.message"
              class="message-row"
              :class="session?.actor === row.message.value.createdBy ? 'message-row--own' : 'message-row--other'"
            >
              <MessageBubble
                :message="row.message"
                :is-own="session?.actor === row.message.value.createdBy"
                :is-pinned="true"
                :can-act="false"
                :sender-label="senderLabel(row.message.value.createdBy)"
                :avatar-photo-url="bubbleAvatar(row.message.value.createdBy).photoUrl"
                :avatar-initial="bubbleAvatar(row.message.value.createdBy).initial"
                :session-actor="session.actor"
                :poll-visual="pollVisualForPinned(row.message)"
                @poll-vote="onPollVoteFromBubblePinned(row.message, $event)"
              />
            </div>
            <div v-else class="pinned-thread-missing message-row message-row--other">
              <p class="pinned-missing-note">This message is no longer in the thread.</p>
            </div>
            <p class="pinned-thread-byline">{{ pinnedByline(row) }}</p>
            <div class="pinned-thread-actions">
              <button
                type="button"
                class="btn btn-ghost pinned-unpin-btn"
                :disabled="!session?.actor"
                @click="unpinRow(row)"
              >
                Unpin
              </button>
            </div>
          </li>
        </ul>
      </div>
      </template>

      <div v-else class="chat-login-gate chat-login-gate--tight">
        <p class="chat-login-gate-title">Loading…</p>
      </div>
    </div>
  `,
});

const DesignVersionsView = defineComponent({
  name: "DesignVersionsView",
  props: {
    chatId: { type: String, required: true },
  },
  setup(props) {
    const session = useGraffitiSession();
    const graffiti = useGraffiti();
    const router = useRouter();

    const { objects: chatObjects, isFirstPoll: isFirstChatPoll } = useGraffitiDiscover(
      CHATS_CHANNELS,
      chatsChannelSchema,
    );
    const chatMeta = computed(() =>
      mergeChatMeta(props.chatId, chatObjects.value),
    );
    const chatName = computed(() => chatMeta.value.name || "Chat");

    const canViewChat = computed(() =>
      canAccessChat(chatMeta.value, session.value?.actor),
    );

    const showChatAccessDenied = computed(() => {
      const actor = session.value?.actor;
      if (!actor) return false;
      if (isFirstChatPoll.value) return false;
      return !canAccessChat(chatMeta.value, actor);
    });

    const showChatAccessLoading = computed(
      () => !!session.value?.actor && isFirstChatPoll.value,
    );

    const { objects: designVersionRawObjects } = useGraffitiDiscover(
      DESIGN_VERSIONS_CHANNELS,
      designVersionsDiscoverSchema,
    );

    const { objects: commentObjects } = useGraffitiDiscover(
      DESIGN_COMMENTS_CHANNELS,
      designCommentSchema,
    );

    const { objects: profileObjects } = useGraffitiDiscover(
      PROFILES_CHANNELS,
      profileSchema,
    );

    const profileIndex = computed(() =>
      profileIndexFromObjects(profileObjects.value),
    );

    const versions = computed(() => {
      if (!canAccessChat(chatMeta.value, session.value?.actor)) {
        return [];
      }
      return mergeDesignVersions(
        designVersionRawObjects.value.filter(
          (o) => o.value?.chatId === props.chatId,
        ),
      );
    });

    function formatDateTime(ts) {
      if (ts == null) return "—";
      try {
        return new Date(ts).toLocaleString(undefined, {
          dateStyle: "short",
          timeStyle: "short",
        });
      } catch {
        return "—";
      }
    }

    function notesPreview(notes) {
      const s = typeof notes === "string" ? notes.trim() : "";
      if (!s) return "—";
      return s.length > 140 ? s.slice(0, 137) + "…" : s;
    }

    function statusBadgeClass(status) {
      if (status === "approved") return "version-status-badge version-status-badge--approved";
      if (status === "needs_revision") return "version-status-badge version-status-badge--revision";
      if (status === "archived") return "version-status-badge version-status-badge--archived";
      return "version-status-badge version-status-badge--draft";
    }

    function statusLabel(status) {
      if (status === "needs_revision") return "Needs revision";
      if (status === "approved") return "Approved";
      if (status === "archived") return "Archived";
      return "Draft";
    }

    function statusIconKind(status) {
      if (status === "approved") return "ok";
      if (status === "needs_revision") return "warn";
      return "";
    }

    function countComments(versionId) {
      return commentCountForVersion(
        commentObjects.value,
        props.chatId,
        versionId,
      );
    }

    function labelFor(actor) {
      return displayUser(profileIndex.value, actor);
    }

    function goBack() {
      router.push("/chat/" + props.chatId);
    }

    const versionsSearch = ref("");
    const versionsSort = ref("newest");

    const displayedVersions = computed(() => {
      let list = [...versions.value];
      const q = versionsSearch.value.trim().toLowerCase();
      if (q) {
        list = list.filter((v) => {
          const tags = Array.isArray(v.tags) ? v.tags.join(" ") : "";
          const blob = [v.title, v.notes, tags].join(" ").toLowerCase();
          return blob.includes(q);
        });
      }
      const sort = versionsSort.value;
      if (sort === "newest") {
        list.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
      } else if (sort === "oldest") {
        list.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
      } else if (sort === "title_az") {
        list.sort((a, b) =>
          String(a.title ?? "").localeCompare(String(b.title ?? ""), undefined, {
            sensitivity: "base",
          }),
        );
      } else if (sort === "title_za") {
        list.sort((a, b) =>
          String(b.title ?? "").localeCompare(String(a.title ?? ""), undefined, {
            sensitivity: "base",
          }),
        );
      }
      return list;
    });

    const deleteConfirmVersion = ref(null);
    const deleteUndoVisible = ref(false);
    const lastHiddenVersionIdForUndo = ref(null);
    let versionsDeleteUndoTimer = null;

    function requestDeleteVersion(v) {
      deleteConfirmVersion.value = v;
    }

    function cancelDeleteVersion() {
      deleteConfirmVersion.value = null;
    }

    async function confirmDeleteVersion() {
      const row = deleteConfirmVersion.value;
      cancelDeleteVersion();
      if (!row) return;
      const s = session.value;
      if (!s?.actor || !canViewChat.value) return;
      try {
        await graffiti.post(
          {
            value: {
              type: "hide_design_version",
              hideId: crypto.randomUUID(),
              versionId: row.versionId,
              chatId: props.chatId,
              hiddenAt: Date.now(),
              hiddenBy: s.actor,
            },
            channels: DESIGN_VERSIONS_CHANNELS,
          },
          s,
        );
        lastHiddenVersionIdForUndo.value = row.versionId;
        deleteUndoVisible.value = true;
        if (versionsDeleteUndoTimer != null) clearTimeout(versionsDeleteUndoTimer);
        versionsDeleteUndoTimer = window.setTimeout(() => {
          deleteUndoVisible.value = false;
          lastHiddenVersionIdForUndo.value = null;
          versionsDeleteUndoTimer = null;
        }, 12000);
      } catch (e) {
        console.error(e);
      }
    }

    async function undoRemoveVersion() {
      const vid = lastHiddenVersionIdForUndo.value;
      deleteUndoVisible.value = false;
      lastHiddenVersionIdForUndo.value = null;
      if (versionsDeleteUndoTimer != null) {
        clearTimeout(versionsDeleteUndoTimer);
        versionsDeleteUndoTimer = null;
      }
      if (!vid) return;
      const s = session.value;
      if (!s?.actor || !canViewChat.value) return;
      try {
        await graffiti.post(
          {
            value: {
              type: "restore_design_version",
              restoreId: crypto.randomUUID(),
              versionId: vid,
              chatId: props.chatId,
              restoredAt: Date.now(),
              restoredBy: s.actor,
            },
            channels: DESIGN_VERSIONS_CHANNELS,
          },
          s,
        );
      } catch (e) {
        console.error(e);
      }
    }

    onBeforeUnmount(() => {
      if (versionsDeleteUndoTimer != null) clearTimeout(versionsDeleteUndoTimer);
    });

    const uploadOpen = ref(false);
    const uploadTitle = ref("");
    const uploadNotes = ref("");
    const uploadStatus = ref("draft");
    const uploadTags = ref("");
    const uploadImagePreview = ref("");
    const uploadBusy = ref(false);
    const uploadError = ref("");
    const uploadPublishPulse = ref(false);

    function openUpload(prefillTitle) {
      uploadError.value = "";
      uploadTitle.value =
        typeof prefillTitle === "string" ? prefillTitle : "";
      uploadNotes.value = "";
      uploadStatus.value = "draft";
      uploadTags.value = "";
      uploadImagePreview.value = "";
      uploadOpen.value = true;
    }

    function closeUpload() {
      uploadOpen.value = false;
    }

    async function onUploadImageChange(e) {
      const input = e.target;
      const file = input.files?.[0];
      if (input) input.value = "";
      if (!file) return;
      if (file.size > MAX_ATTACHMENT_BYTES) {
        uploadError.value = "Image must be under 2 MB.";
        return;
      }
      uploadError.value = "";
      try {
        uploadImagePreview.value = await readFileAsDataUrl(file);
      } catch (err) {
        console.error(err);
        uploadError.value = "Could not read the image.";
      }
    }

    async function submitUpload() {
      const s = session.value;
      if (!s?.actor) {
        uploadError.value = "Log in to upload.";
        return;
      }
      if (!canViewChat.value) {
        uploadError.value = "You do not have access to this chat.";
        return;
      }
      const title = uploadTitle.value.trim();
      if (!title) {
        uploadError.value = "Enter a title.";
        return;
      }
      if (!uploadImagePreview.value) {
        uploadError.value = "Choose an image.";
        return;
      }
      uploadPublishPulse.value = true;
      window.setTimeout(() => {
        uploadPublishPulse.value = false;
      }, 280);
      uploadBusy.value = true;
      uploadError.value = "";
      try {
        await graffiti.post(
          {
            value: {
              type: "create_design_version",
              versionId: crypto.randomUUID(),
              chatId: props.chatId,
              title,
              notes: uploadNotes.value.trim(),
              imageDataUrl: uploadImagePreview.value,
              status: uploadStatus.value,
              tags: parseCommaTags(uploadTags.value),
              createdAt: Date.now(),
              createdBy: s.actor,
            },
            channels: DESIGN_VERSIONS_CHANNELS,
          },
          s,
        );
        uploadOpen.value = false;
      } catch (e) {
        console.error(e);
        uploadError.value = "Could not upload. Try again.";
      } finally {
        uploadBusy.value = false;
      }
    }

    return {
      session,
      chatName,
      versions,
      displayedVersions,
      versionsSearch,
      versionsSort,
      canViewChat,
      showChatAccessDenied,
      showChatAccessLoading,
      formatDateTime,
      notesPreview,
      statusBadgeClass,
      statusLabel,
      statusIconKind,
      countComments,
      labelFor,
      goBack,
      deleteConfirmVersion,
      deleteUndoVisible,
      requestDeleteVersion,
      cancelDeleteVersion,
      confirmDeleteVersion,
      undoRemoveVersion,
      uploadOpen,
      uploadTitle,
      uploadNotes,
      uploadStatus,
      uploadTags,
      uploadImagePreview,
      uploadBusy,
      uploadError,
      uploadPublishPulse,
      openUpload,
      closeUpload,
      onUploadImageChange,
      submitUpload,
    };
  },
  template: `
    <div class="versions-page">
      <header class="versions-header versions-header--elevated">
        <div class="versions-header-top">
          <button type="button" class="btn btn-ghost versions-back" @click="goBack" aria-label="Back to chat">
            ← Back
          </button>
        </div>
        <h1 class="versions-title">Design Versions</h1>
        <p v-if="session?.actor && canViewChat" class="versions-subtitle">{{ chatName }}</p>
      </header>

      <div v-if="session === null" class="chat-login-gate chat-login-gate--tight">
        <p class="chat-login-gate-title">Log in to view this chat.</p>
        <p class="chat-login-gate-text">Design versions and artwork stay private until you sign in from the sidebar.</p>
      </div>

      <div v-else-if="session === undefined" class="chat-login-gate chat-login-gate--tight">
        <p class="chat-login-gate-title">Loading…</p>
      </div>

      <div v-else-if="showChatAccessLoading" class="chat-login-gate chat-login-gate--tight">
        <p class="chat-login-gate-title">Loading chat…</p>
      </div>

      <div v-else-if="showChatAccessDenied" class="chat-login-gate chat-access-denied">
        <p class="chat-login-gate-title">You do not have access to this chat.</p>
        <p class="chat-login-gate-text">Ask the creator to add your member ID, or pick a room from your sidebar.</p>
      </div>

      <template v-else-if="canViewChat && session?.actor">
      <div v-if="deleteUndoVisible" class="versions-undo-toast delete-undo-toast" role="status">
        <span>Version removed from the list.</span>
        <button type="button" class="btn btn-ghost btn-sm delete-undo-btn" @click="undoRemoveVersion">
          Undo
        </button>
      </div>

      <div class="versions-toolbar">
        <label class="versions-toolbar-search">
          <span class="visually-hidden">Search versions</span>
          <input
            v-model="versionsSearch"
            type="search"
            class="versions-toolbar-input"
            placeholder="Search title, notes, tags…"
            autocomplete="off"
          />
        </label>
        <div class="versions-toolbar-sort">
          <label for="versions-sort" class="versions-toolbar-sort-label">Sort</label>
          <select id="versions-sort" v-model="versionsSort" class="versions-toolbar-select">
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="title_az">Title A–Z</option>
            <option value="title_za">Title Z–A</option>
          </select>
        </div>
      </div>

      <div class="versions-body">
        <p v-if="versions.length === 0" class="versions-empty">
          No design versions yet. Upload the first version.
        </p>
        <p v-else-if="displayedVersions.length === 0" class="versions-empty">
          No versions match your search.
        </p>
        <ul v-else class="versions-list">
          <li v-for="v in displayedVersions" :key="v.versionId" class="versions-list-item">
            <router-link
              :to="'/chat/' + chatId + '/versions/' + v.versionId"
              class="version-card"
            >
              <div class="version-thumb-wrap">
                <img
                  v-if="v.imageDataUrl"
                  :src="v.imageDataUrl"
                  alt=""
                  class="version-thumb"
                />
                <div v-else class="version-thumb version-thumb--placeholder" aria-hidden="true">🖼</div>
              </div>
              <div class="version-card-main">
                <div class="version-card-row1">
                  <h2 class="version-card-title">{{ v.title }}</h2>
                  <span v-if="statusIconKind(v.status)" class="version-card-status-ico" :class="'version-card-status-ico--' + statusIconKind(v.status)" aria-hidden="true">
                    <template v-if="statusIconKind(v.status) === 'ok'">✓</template>
                    <template v-else>!</template>
                  </span>
                </div>
                <p class="version-card-time">{{ formatDateTime(v.createdAt) }}</p>
                <p class="version-card-notes">{{ notesPreview(v.notes) }}</p>
                <div class="version-card-meta">
                  <span :class="statusBadgeClass(v.status)">{{ statusLabel(v.status) }}</span>
                  <span class="version-card-comments">{{ countComments(v.versionId) }} comments</span>
                  <span class="version-card-by">{{ labelFor(v.createdBy) }}</span>
                </div>
              </div>
            </router-link>
            <button
              type="button"
              class="version-card-remove"
              aria-label="Remove version from list"
              title="Remove"
              @click.stop.prevent="requestDeleteVersion(v)"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M3 6h18M8 6V4h8v2M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M10 11v6M14 11v6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
              </svg>
            </button>
          </li>
        </ul>
      </div>

      <div v-if="session?.actor && canViewChat" class="versions-footer">
        <button type="button" class="btn btn-vers-primary btn-vers-primary--block" @click="openUpload()">
          Upload New Version
        </button>
      </div>
      </template>

      <div v-else class="chat-login-gate chat-login-gate--tight">
        <p class="chat-login-gate-title">Loading…</p>
      </div>

      <div
        v-if="deleteConfirmVersion && session?.actor && canViewChat"
        class="design-upload-overlay"
        role="presentation"
        @click.self="cancelDeleteVersion"
      >
        <div class="composer-modal" role="alertdialog" aria-labelledby="vdel-title" aria-describedby="vdel-desc" @click.stop>
          <h3 id="vdel-title" class="composer-modal-title">Remove this version?</h3>
          <p id="vdel-desc" class="versions-delete-confirm-text">
            It will disappear from everyone’s list in this chat. Other clients can still see raw channel data;
            this app treats it as removed until you restore it.
          </p>
          <p class="versions-delete-confirm-text versions-delete-confirm-text--muted">
            You’ll have a short time to <strong>Undo</strong> after removing.
          </p>
          <div class="composer-modal-actions">
            <button type="button" class="btn btn-ghost" @click="cancelDeleteVersion">Cancel</button>
            <button type="button" class="btn btn-primary" @click="confirmDeleteVersion">Remove</button>
          </div>
        </div>
      </div>

      <div
        v-if="uploadOpen && session?.actor && canViewChat"
        class="design-upload-overlay"
        role="presentation"
        @click.self="closeUpload"
      >
        <div class="design-upload-modal" role="dialog" aria-labelledby="dupload-title" @click.stop>
          <h3 id="dupload-title" class="design-upload-title">Upload design version</h3>
          <label class="design-upload-label">
            Title
            <input v-model="uploadTitle" type="text" class="design-upload-input" placeholder="Version title" autocomplete="off" />
          </label>
          <label class="design-upload-label">
            Notes
            <textarea v-model="uploadNotes" class="design-upload-textarea" rows="3" placeholder="Notes for reviewers"></textarea>
          </label>
          <label class="design-upload-label">
            Image
            <input type="file" accept="image/*" class="design-upload-file" @change="onUploadImageChange" />
          </label>
          <div v-if="uploadImagePreview" class="design-upload-preview-wrap">
            <img :src="uploadImagePreview" alt="" class="design-upload-preview" />
          </div>
          <label class="design-upload-label">
            Status
            <select v-model="uploadStatus" class="design-upload-select">
              <option value="draft">Draft</option>
              <option value="needs_revision">Needs revision</option>
              <option value="approved">Approved</option>
              <option value="archived">Archived</option>
            </select>
          </label>
          <label class="design-upload-label">
            Tags (comma-separated)
            <input v-model="uploadTags" type="text" class="design-upload-input" placeholder="fabric, trim, …" autocomplete="off" />
          </label>
          <p v-if="uploadError" class="design-upload-error">{{ uploadError }}</p>
          <div class="design-upload-actions">
            <button type="button" class="btn btn-ghost" @click="closeUpload">Cancel</button>
            <button
              type="button"
              :class="['btn', 'btn-vers-primary', { 'btn-action-feedback': uploadPublishPulse }]"
              :disabled="uploadBusy"
              @click="submitUpload"
            >
              {{ uploadBusy ? 'Saving…' : 'Publish version' }}
            </button>
          </div>
          <p v-if="session === null" class="design-upload-hint">Log in to publish.</p>
        </div>
      </div>
    </div>
  `,
});

const DesignVersionDetailView = defineComponent({
  name: "DesignVersionDetailView",
  props: {
    chatId: { type: String, required: true },
    versionId: { type: String, required: true },
  },
  setup(props) {
    const session = useGraffitiSession();
    const graffiti = useGraffiti();
    const router = useRouter();

    const { objects: chatObjects, isFirstPoll: isFirstChatPoll } = useGraffitiDiscover(
      CHATS_CHANNELS,
      chatsChannelSchema,
    );
    const chatMeta = computed(() =>
      mergeChatMeta(props.chatId, chatObjects.value),
    );
    const chatName = computed(() => chatMeta.value.name || "Chat");

    const canViewChat = computed(() =>
      canAccessChat(chatMeta.value, session.value?.actor),
    );

    const showChatAccessDenied = computed(() => {
      const actor = session.value?.actor;
      if (!actor) return false;
      if (isFirstChatPoll.value) return false;
      return !canAccessChat(chatMeta.value, actor);
    });

    const showChatAccessLoading = computed(
      () => !!session.value?.actor && isFirstChatPoll.value,
    );

    const { objects: designVersionRawObjects } = useGraffitiDiscover(
      DESIGN_VERSIONS_CHANNELS,
      designVersionsDiscoverSchema,
    );

    const { objects: commentObjects } = useGraffitiDiscover(
      DESIGN_COMMENTS_CHANNELS,
      designCommentSchema,
    );

    const { objects: profileObjects } = useGraffitiDiscover(
      PROFILES_CHANNELS,
      profileSchema,
    );

    const profileIndex = computed(() =>
      profileIndexFromObjects(profileObjects.value),
    );

    const versions = computed(() => {
      if (!canAccessChat(chatMeta.value, session.value?.actor)) {
        return [];
      }
      return mergeDesignVersions(
        designVersionRawObjects.value.filter(
          (o) => o.value?.chatId === props.chatId,
        ),
      );
    });

    const version = computed(() => {
      const id = props.versionId;
      return versions.value.find((v) => v.versionId === id) ?? null;
    });

    const chatComments = computed(() =>
      commentObjects.value.filter((o) => o.value?.chatId === props.chatId),
    );

    const threadComments = computed(() => {
      if (!canAccessChat(chatMeta.value, session.value?.actor)) {
        return [];
      }
      return commentsForVersion(chatComments.value, props.versionId);
    });

    function formatDateTime(ts) {
      if (ts == null) return "—";
      try {
        return new Date(ts).toLocaleString(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        });
      } catch {
        return "—";
      }
    }

    function formatCommentTime(ts) {
      if (ts == null) return "";
      try {
        return new Date(ts).toLocaleString(undefined, {
          hour: "numeric",
          minute: "2-digit",
          month: "short",
          day: "numeric",
        });
      } catch {
        return "";
      }
    }

    function labelFor(actor) {
      return displayUser(profileIndex.value, actor);
    }

    function avatarFor(actor) {
      return displayAvatar(profileIndex.value, actor);
    }

    function goBack() {
      router.push("/chat/" + props.chatId + "/versions");
    }

    const editTitle = ref("");
    const editNotes = ref("");
    const editTags = ref("");
    const editStatus = ref("draft");
    const editImageOverride = ref(null);
    const editBusy = ref(false);
    const editError = ref("");
    const editSavePulse = ref(false);

    watch(
      () => version.value,
      (v) => {
        if (!v) return;
        editTitle.value = v.title ?? "";
        editNotes.value = v.notes ?? "";
        editTags.value = Array.isArray(v.tags) ? v.tags.join(", ") : "";
        editStatus.value = v.status ?? "draft";
        editImageOverride.value = null;
        editError.value = "";
      },
      { immediate: true },
    );

    const heroImageSrc = computed(
      () => editImageOverride.value ?? version.value?.imageDataUrl ?? "",
    );

    const heroLightboxOpen = ref(false);

    watch(
      () => heroImageSrc.value,
      () => {
        heroLightboxOpen.value = false;
      },
    );

    watch(heroLightboxOpen, (open, _prev, onCleanup) => {
      if (!open) return;
      const onKey = (e) => {
        if (e.key === "Escape") heroLightboxOpen.value = false;
      };
      document.addEventListener("keydown", onKey, true);
      onCleanup(() => document.removeEventListener("keydown", onKey, true));
    });

    async function onEditImageChange(e) {
      const input = e.target;
      const file = input.files?.[0];
      if (input) input.value = "";
      if (!file) return;
      if (file.size > MAX_ATTACHMENT_BYTES) {
        editError.value = "Image must be under 2 MB.";
        return;
      }
      editError.value = "";
      try {
        editImageOverride.value = await readFileAsDataUrl(file);
      } catch (err) {
        console.error(err);
        editError.value = "Could not read the image.";
      }
    }

    async function saveVersionEdits() {
      const s = session.value;
      const v = version.value;
      if (!s?.actor || !v) return;
      if (!canViewChat.value) {
        editError.value = "You do not have access to this chat.";
        return;
      }
      const title = editTitle.value.trim();
      if (!title) {
        editError.value = "Enter a title.";
        return;
      }
      const imageUrl =
        editImageOverride.value != null
          ? editImageOverride.value
          : v.imageDataUrl;
      if (!imageUrl) {
        editError.value = "Add an image.";
        return;
      }
      const notes = editNotes.value.trim();
      const tags = parseCommaTags(editTags.value);
      const status = editStatus.value;
      const sameContent =
        title === (v.title || "") &&
        notes === (v.notes || "").trim() &&
        designTagsEqual(tags, v.tags) &&
        editImageOverride.value === null;
      const sameStatus = status === v.status;
      if (sameContent && sameStatus) return;
      editSavePulse.value = true;
      window.setTimeout(() => {
        editSavePulse.value = false;
      }, 280);
      editBusy.value = true;
      editError.value = "";
      try {
        if (!sameContent) {
          await graffiti.post(
            {
              value: {
                type: "update_design_version",
                versionId: props.versionId,
                chatId: props.chatId,
                title,
                notes,
                imageDataUrl: imageUrl,
                tags,
                updatedAt: Date.now(),
                updatedBy: s.actor,
              },
              channels: DESIGN_VERSIONS_CHANNELS,
            },
            s,
          );
        }
        if (!sameStatus) {
          await graffiti.post(
            {
              value: {
                type: "update_design_version_status",
                versionId: props.versionId,
                chatId: props.chatId,
                status,
                updatedAt: Date.now(),
                updatedBy: s.actor,
              },
              channels: DESIGN_VERSIONS_CHANNELS,
            },
            s,
          );
        }
        editImageOverride.value = null;
      } catch (e) {
        console.error(e);
        editError.value = "Could not save changes.";
      } finally {
        editBusy.value = false;
      }
    }

    const commentText = ref("");
    const commentBusy = ref(false);
    const commentError = ref("");
    const commentSendPulse = ref(false);

    async function sendComment() {
      const s = session.value;
      if (!s?.actor) {
        commentError.value = "Log in to comment.";
        return;
      }
      if (!canViewChat.value) {
        commentError.value = "You do not have access to this chat.";
        return;
      }
      const text = commentText.value.trim();
      if (!text) return;
      if (!version.value) return;
      commentSendPulse.value = true;
      window.setTimeout(() => {
        commentSendPulse.value = false;
      }, 280);
      commentBusy.value = true;
      commentError.value = "";
      try {
        await graffiti.post(
          {
            value: {
              type: "create_design_comment",
              commentId: crypto.randomUUID(),
              versionId: props.versionId,
              chatId: props.chatId,
              content: text,
              createdAt: Date.now(),
              createdBy: s.actor,
            },
            channels: DESIGN_COMMENTS_CHANNELS,
          },
          s,
        );
        commentText.value = "";
      } catch (e) {
        console.error(e);
        commentError.value = "Comment could not be sent.";
      } finally {
        commentBusy.value = false;
      }
    }

    return {
      session,
      chatName,
      version,
      threadComments,
      canViewChat,
      showChatAccessDenied,
      showChatAccessLoading,
      formatDateTime,
      formatCommentTime,
      labelFor,
      avatarFor,
      goBack,
      editTitle,
      editNotes,
      editTags,
      editStatus,
      editBusy,
      editError,
      editSavePulse,
      heroImageSrc,
      heroLightboxOpen,
      onEditImageChange,
      saveVersionEdits,
      commentText,
      commentBusy,
      commentError,
      commentSendPulse,
      sendComment,
    };
  },
  template: `
    <div class="version-detail-page">
      <template v-if="session === null">
        <header class="versions-header version-detail-header">
          <div class="versions-header-top">
            <button type="button" class="btn btn-ghost versions-back" @click="goBack" aria-label="Back to versions">
              ← Back
            </button>
          </div>
          <h1 class="versions-title version-detail-title">Design version</h1>
        </header>
        <div class="chat-login-gate chat-login-gate--tight">
          <p class="chat-login-gate-title">Log in to view this chat.</p>
          <p class="chat-login-gate-text">Version details and comments stay private until you sign in from the sidebar.</p>
        </div>
      </template>

      <template v-else-if="session === undefined">
        <header class="versions-header version-detail-header">
          <div class="versions-header-top">
            <button type="button" class="btn btn-ghost versions-back" @click="goBack" aria-label="Back to versions">
              ← Back
            </button>
          </div>
          <h1 class="versions-title version-detail-title">Design version</h1>
        </header>
        <div class="chat-login-gate chat-login-gate--tight">
          <p class="chat-login-gate-title">Loading…</p>
        </div>
      </template>

      <template v-else-if="showChatAccessLoading">
        <header class="versions-header version-detail-header">
          <div class="versions-header-top">
            <button type="button" class="btn btn-ghost versions-back" @click="goBack" aria-label="Back to versions">
              ← Back
            </button>
          </div>
          <h1 class="versions-title version-detail-title">Design version</h1>
        </header>
        <div class="chat-login-gate chat-login-gate--tight">
          <p class="chat-login-gate-title">Loading chat…</p>
        </div>
      </template>

      <template v-else-if="showChatAccessDenied">
        <header class="versions-header version-detail-header">
          <div class="versions-header-top">
            <button type="button" class="btn btn-ghost versions-back" @click="goBack" aria-label="Back to versions">
              ← Back
            </button>
          </div>
          <h1 class="versions-title version-detail-title">Design version</h1>
        </header>
        <div class="chat-login-gate chat-access-denied">
          <p class="chat-login-gate-title">You do not have access to this chat.</p>
          <p class="chat-login-gate-text">Ask the creator to add your member ID, or pick a room from your sidebar.</p>
        </div>
      </template>

      <template v-else-if="canViewChat && session?.actor">
      <header class="versions-header version-detail-header">
        <div class="versions-header-top">
          <button type="button" class="btn btn-ghost versions-back" @click="goBack" aria-label="Back to versions">
            ← Back
          </button>
        </div>
        <template v-if="version">
          <label class="version-detail-title-field">
            <span class="visually-hidden">Version title</span>
            <input
              v-model="editTitle"
              type="text"
              class="version-detail-title-input"
              autocomplete="off"
            />
          </label>
          <p class="versions-subtitle">{{ formatDateTime(version.createdAt) }}</p>
        </template>
        <template v-else>
          <h1 class="versions-title version-detail-title">Version</h1>
          <p class="versions-subtitle">{{ chatName }}</p>
        </template>
      </header>

      <div v-if="!version" class="versions-body">
        <p class="versions-empty">This design version was not found.</p>
        <button type="button" class="btn btn-vers-primary" @click="goBack">Back to list</button>
      </div>

      <template v-else>
        <button
          v-if="heroImageSrc"
          type="button"
          class="version-hero version-hero--thumb"
          aria-label="Expand design image"
          @click="heroLightboxOpen = true"
        >
          <span class="version-hero-frame-open">
            <img :src="heroImageSrc" alt="" class="version-hero-img" />
          </span>
        </button>
        <div v-else class="version-hero version-hero--empty" aria-hidden="true">
          <div class="version-hero-frame version-hero-frame--placeholder">
            <span class="version-hero-placeholder">No image</span>
          </div>
        </div>

        <div
          v-if="heroLightboxOpen && heroImageSrc"
          class="version-hero-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="Full size preview"
          @click.self="heroLightboxOpen = false"
        >
          <button
            type="button"
            class="version-hero-lightbox-close"
            aria-label="Close preview"
            @click="heroLightboxOpen = false"
          >
            ×
          </button>
          <img :src="heroImageSrc" alt="" class="version-hero-lightbox-img" @click.stop />
        </div>

        <div class="version-detail-body">
          <section class="version-detail-section">
            <h3 class="version-detail-k">Uploaded by</h3>
            <div class="version-uploader">
              <div class="version-uploader-ava">
                <img
                  v-if="avatarFor(version.createdBy).photoUrl"
                  :src="avatarFor(version.createdBy).photoUrl"
                  alt=""
                  class="version-uploader-img"
                />
                <span v-else class="version-uploader-init">{{ avatarFor(version.createdBy).initial }}</span>
              </div>
              <span class="version-uploader-name">{{ labelFor(version.createdBy) }}</span>
            </div>
          </section>

          <section class="version-detail-section">
            <h3 class="version-detail-k">Edit version</h3>
            <label class="design-upload-label">
              Notes
              <textarea
                v-model="editNotes"
                class="design-upload-textarea"
                rows="4"
                placeholder="Notes for reviewers"
              ></textarea>
            </label>
            <label class="design-upload-label">
              Tags (comma-separated)
              <input
                v-model="editTags"
                type="text"
                class="design-upload-input"
                placeholder="fabric, trim, …"
                autocomplete="off"
              />
            </label>
            <label class="design-upload-label">
              Status
              <select v-model="editStatus" class="design-upload-select">
                <option value="draft">Draft</option>
                <option value="needs_revision">Needs revision</option>
                <option value="approved">Approved</option>
                <option value="archived">Archived</option>
              </select>
            </label>
            <label class="design-upload-label">
              Image
              <input type="file" accept="image/*" class="design-upload-file" @change="onEditImageChange" />
            </label>
            <p v-if="editError" class="design-upload-error">{{ editError }}</p>
            <button
              type="button"
              :class="['btn', 'btn-vers-primary', 'version-save-btn', { 'btn-action-feedback': editSavePulse }]"
              :disabled="editBusy"
              @click="saveVersionEdits"
            >
              {{ editBusy ? 'Saving…' : 'Save changes' }}
            </button>
          </section>

          <section class="version-detail-section version-comments-section">
            <h3 class="version-detail-k">Comments</h3>
            <ul v-if="threadComments.length" class="version-comment-list">
              <li v-for="c in threadComments" :key="c.value.commentId" class="version-comment-card">
                <div class="version-comment-ava">
                  <img
                    v-if="avatarFor(c.value.createdBy).photoUrl"
                    :src="avatarFor(c.value.createdBy).photoUrl"
                    alt=""
                    class="version-comment-img"
                  />
                  <span v-else class="version-comment-init">{{ avatarFor(c.value.createdBy).initial }}</span>
                </div>
                <div class="version-comment-body">
                  <div class="version-comment-top">
                    <span class="version-comment-name">{{ labelFor(c.value.createdBy) }}</span>
                    <span class="version-comment-time">{{ formatCommentTime(c.value.createdAt) }}</span>
                  </div>
                  <p class="version-comment-text">{{ c.value.content }}</p>
                </div>
              </li>
            </ul>
            <p v-else class="version-detail-muted">No comments yet.</p>
          </section>
        </div>

        <div class="version-comment-composer">
          <p v-if="session === null" class="design-upload-hint">Log in to add a comment.</p>
          <template v-else>
            <input
              v-model="commentText"
              type="text"
              class="version-comment-input"
              placeholder="Add a comment…"
              autocomplete="off"
              @keydown.enter.prevent="sendComment"
            />
            <button
              type="button"
              :class="['btn', 'btn-vers-primary', 'version-comment-send', { 'btn-action-feedback': commentSendPulse }]"
              :disabled="commentBusy || !commentText.trim()"
              @click="sendComment"
            >
              Send
            </button>
          </template>
          <p v-if="commentError" class="design-upload-error">{{ commentError }}</p>
        </div>
      </template>
      </template>

      <template v-else>
        <header class="versions-header version-detail-header">
          <div class="versions-header-top">
            <button type="button" class="btn btn-ghost versions-back" @click="goBack" aria-label="Back to versions">
              ← Back
            </button>
          </div>
          <h1 class="versions-title version-detail-title">Design version</h1>
        </header>
        <div class="chat-login-gate chat-login-gate--tight">
          <p class="chat-login-gate-title">Loading…</p>
        </div>
      </template>
    </div>
  `,
});

const JoinChatView = defineComponent({
  name: "JoinChatView",
  props: {
    chatId: { type: String, required: true },
    inviteToken: { type: String, required: true },
  },
  setup(props) {
    const session = useGraffitiSession();
    const graffiti = useGraffiti();
    const router = useRouter();
    const busy = ref(false);
    const error = ref("");

    const { objects: chatObjects, isFirstPoll: isFirstChatPoll } = useGraffitiDiscover(
      CHATS_CHANNELS,
      chatsChannelSchema,
    );

    const chatMeta = computed(() =>
      mergeChatMeta(props.chatId, chatObjects.value),
    );

    const routeToken = computed(() => String(props.inviteToken || "").trim());

    /** Latest merged invite token must match URL segment (secret proves invite intent in this UI only). */
    const inviteValid = computed(() => {
      if (!chatMeta.value.chatExists) return false;
      if (!chatMeta.value.inviteLinkEnabled) return false;
      return chatMeta.value.inviteToken === routeToken.value;
    });

    const alreadyMember = computed(() => {
      const a = session.value?.actor;
      if (!a) return false;
      return canAccessChat(chatMeta.value, a);
    });

    watch(
      [alreadyMember, inviteValid, isFirstChatPoll],
      () => {
        if (isFirstChatPoll.value) return;
        if (!inviteValid.value) return;
        if (alreadyMember.value) {
          router.replace("/chat/" + props.chatId);
        }
      },
      { immediate: true },
    );

    async function join() {
      const s = session.value;
      error.value = "";
      if (!s?.actor) {
        error.value = "Log in from the sidebar to join.";
        return;
      }
      if (!inviteValid.value) {
        error.value = "This invite link is invalid or expired.";
        return;
      }
      const creator = chatMeta.value.createdBy;
      if (!creator) {
        error.value = "This chat could not be found.";
        return;
      }
      busy.value = true;
      try {
        await graffiti.post(
          {
            value: {
              type: "add_chat_member",
              chatId: props.chatId,
              actor: s.actor,
              addedAt: Date.now(),
              addedBy: creator,
            },
            channels: CHATS_CHANNELS,
          },
          s,
        );
        router.replace("/chat/" + props.chatId);
      } catch (e) {
        console.error(e);
        error.value = "Could not join. Try again.";
      } finally {
        busy.value = false;
      }
    }

    const chatName = computed(() => chatMeta.value.name || "Chat");

    return {
      session,
      chatMeta,
      chatName,
      isFirstChatPoll,
      inviteValid,
      alreadyMember,
      busy,
      error,
      join,
    };
  },
  template: `
    <div class="chat-panel-static join-chat-panel">
      <div class="chat-panel-static-inner join-chat-inner">
        <h2>Join chat</h2>

        <template v-if="session === undefined">
          <p class="hint">Loading…</p>
        </template>

        <template v-else-if="session === null">
          <p class="hint">Sign in from the sidebar to accept this invite.</p>
          <p class="hint join-chat-privacy-hint">
            Invite tokens are checked only by this app; treat links like weak secrets until you use private channels or encrypted payloads.
          </p>
        </template>

        <template v-else-if="isFirstChatPoll">
          <p class="hint">Loading chat…</p>
        </template>

        <template v-else-if="!chatMeta.chatExists">
          <p class="hint">This chat does not exist or has not synced yet.</p>
        </template>

        <template v-else-if="!inviteValid">
          <p class="hint">This invite link is invalid, expired, or was rotated.</p>
          <p class="hint join-chat-muted">Ask the creator for a new link from Chat info → Invite link.</p>
        </template>

        <template v-else-if="alreadyMember">
          <p class="hint">Opening <strong>{{ chatName }}</strong>…</p>
        </template>

        <template v-else>
          <p class="join-chat-lead">
            You’ve been invited to <strong>{{ chatName }}</strong>.
          </p>
          <button
            type="button"
            class="btn btn-primary join-chat-btn"
            :disabled="busy"
            @click="join"
          >
            {{ busy ? 'Joining…' : 'Join chat' }}
          </button>
          <p v-if="error" class="hint join-chat-error">{{ error }}</p>
        </template>
      </div>
    </div>
  `,
});

const UserProfileView = defineComponent({
  name: "UserProfileView",
  props: {
    actorId: { type: String, required: true },
  },
  setup(props) {
    const router = useRouter();
    const session = useGraffitiSession();

    const { objects: profileObjects, isFirstPoll } = useGraffitiDiscover(
      PROFILES_CHANNELS,
      profileSchema,
    );

    const profileIndex = computed(() =>
      profileIndexFromObjects(profileObjects.value),
    );

    const actor = computed(() => props.actorId);

    const profileVal = computed(() =>
      getProfile(profileIndex.value, actor.value),
    );
    const displayName = computed(() =>
      displayUser(profileIndex.value, actor.value),
    );
    const avatar = computed(() =>
      displayAvatar(profileIndex.value, actor.value),
    );
    const idSecondary = computed(() => shortOpaqueId(actor.value));

    async function copyActorId() {
      const ok = await copyTextToClipboard(actor.value);
      if (!ok) {
        alert("Could not copy member ID.");
      }
    }

    function goBack() {
      router.back();
    }

    return {
      session,
      isFirstPoll,
      actor,
      profileVal,
      displayName,
      avatar,
      idSecondary,
      copyActorId,
      goBack,
    };
  },
  template: `
    <div class="chat-panel-static user-profile-page">
      <div class="chat-panel-static-inner user-profile-inner">
        <button type="button" class="btn btn-ghost user-profile-back" @click="goBack">
          ← Back
        </button>
        <div class="user-profile-hero">
          <div class="user-profile-avatar" aria-hidden="true">
            <img
              v-if="avatar.photoUrl"
              :src="avatar.photoUrl"
              alt=""
              class="user-profile-avatar-img"
            />
            <span v-else class="user-profile-avatar-init">{{ avatar.initial }}</span>
          </div>
          <h2 class="user-profile-name">{{ displayName }}</h2>
          <p v-if="session?.actor === actor" class="hint user-profile-you-badge">This is you</p>
          <p class="user-profile-id-secondary">{{ idSecondary }}</p>
          <div class="user-profile-id-row">
            <code class="user-profile-id-full">{{ actor }}</code>
            <button type="button" class="btn-copy-id" @click="copyActorId">Copy ID</button>
          </div>
          <p v-if="profileVal?.theme" class="hint user-profile-theme-hint">
            Uses {{ profileVal.theme }} theme in Studio Chats
          </p>
        </div>
        <p v-if="isFirstPoll && !profileVal" class="hint user-profile-loading">
          Loading profile…
        </p>
      </div>
    </div>
  `,
});

const AboutView = defineComponent({
  name: "AboutView",
  template: `
    <div class="chat-panel-static chat-panel-static--about">
      <div class="chat-panel-static-inner chat-panel-static-inner--about">
        <h2>About Studio Chats</h2>
        <p class="about-lede">
          Studio Chats is a messaging UI on top of <strong>Graffiti</strong>: shared channels hold chats, messages, pins,
          profiles, and optional design-review threads. Everything is <strong>append-only on the network</strong>—the app
          merges updates so you see the latest names, votes, and edits clients agree on.
        </p>

        <section class="about-section">
          <h3 class="about-section-title">Sidebar</h3>
          <ul class="about-list">
            <li>Open an existing room from the list, or use <strong>New Chat</strong> to create one.</li>
            <li><strong>Search chats</strong> filters by name; use <strong>All</strong>, <strong>Unread</strong>, or <strong>Groups</strong> to narrow the list.</li>
            <li>An unread dot appears when there are newer messages than your last-read cursor on this device.</li>
            <li><strong>Settings</strong> (gear): profile name, photo (upload an image file—stored as data on your profile record), and light/dark theme.</li>
          </ul>
        </section>

        <section class="about-section">
          <h3 class="about-section-title">Inside a chat</h3>
          <ul class="about-list">
            <li><strong>Chat</strong> / <strong>Pinned</strong> tabs switch the main view; pinned messages open from the ⋯ menu on a bubble.</li>
            <li>The header opens <strong>Chat info</strong>: room ID, members, optional invite link (creator), editing the chat name/photo, adding members by ID, and searching messages in this room.</li>
            <li><strong>Design Versions</strong> (below the header) opens uploads, search, sort, and version cards; you can remove a version from the list (recover briefly with <strong>Undo</strong>).</li>
          </ul>
        </section>

        <section class="about-section">
          <h3 class="about-section-title">Composer & messages</h3>
          <ul class="about-list">
            <li><strong>Enter</strong> sends; <strong>Shift+Enter</strong> or <strong>Ctrl+Enter</strong> inserts a new line.</li>
            <li>Recognized <strong>http(s)</strong> and <strong>mailto:</strong> links in text render as links and open in a new tab.</li>
            <li>The <strong>+</strong> menu attaches a <strong>file</strong>, <strong>photo/video</strong>, <strong>poll</strong>, or <strong>contact</strong> card. Attachments are limited to <strong>2&nbsp;MB</strong> each.</li>
            <li><strong>Polls:</strong> tap an option to vote; you can change your vote. Counts update as others vote.</li>
            <li><strong>Replies:</strong> start a reply from ⋯ → Reply; the composer shows who you’re quoting.</li>
            <li><strong>Reactions:</strong> tap an emoji chip on a bubble to add or remove yours.</li>
            <li><strong>⋯ menu:</strong> Reply, Pin/Unpin, Copy, or remove the bubble <strong>for you on this device only</strong> (“delete for me”)—others still see it unless your client hides it. You get a short <strong>Undo</strong> window.</li>
          </ul>
        </section>

        <section class="about-section">
          <h3 class="about-section-title">Scrolling & reads</h3>
          <ul class="about-list">
            <li>The thread stays near the bottom when you’re already scrolled down; scroll up to read history without being pulled back on every small update.</li>
            <li>Last-read hints are stored per device to drive unread badges—another device won’t share that exact state.</li>
          </ul>
        </section>

        <section class="about-section">
          <h3 class="about-section-title">Design versions</h3>
          <ul class="about-list">
            <li>Upload images (up to 2&nbsp;MB), set title, notes, tags, and status.</li>
            <li>Open a version to edit fields and replace the image; use the framed preview—tap to expand full screen.</li>
            <li>Comments live on each version thread.</li>
          </ul>
        </section>

        <section class="about-section">
          <h3 class="about-section-title">Invite links & privacy</h3>
          <ul class="about-list">
            <li>The creator can enable an invite URL so signed-in people can join; rotating or disabling the link is supported.</li>
            <li>Sharing a channel still means payloads may be visible to other Graffiti clients—this app enforces access in the UI, not cryptography.</li>
          </ul>
        </section>

        <section class="about-section about-section--footnote">
          <h3 class="about-section-title">Profiles</h3>
          <p class="about-footnote">
            Open a member from chat info or tap an avatar path where linked—profiles show name, photo, and a copyable member ID for invites.
          </p>
        </section>
      </div>
    </div>
  `,
});

const App = defineComponent({
  components: { RouterView, RouterLink },
  setup() {
    const route = useRoute();
    const session = useGraffitiSession();
    const graffiti = useGraffiti();

    const settingsOpen = ref(false);
    const settingsUsername = ref("");
    const settingsPhotoUrl = ref("");
    const settingsTheme = ref("light");
    const settingsBusy = ref(false);
    const settingsError = ref("");
    const settingsSnapshot = ref("");

    function isSidebarChatActive(chatId) {
      return route.params.chatId === chatId;
    }

    const { objects: profileObjects } = useGraffitiDiscover(
      PROFILES_CHANNELS,
      profileSchema,
    );

    const profileIndex = computed(() =>
      profileIndexFromObjects(profileObjects.value),
    );

    const sessionDisplayName = computed(() => {
      const a = session.value?.actor;
      if (!a) return "";
      return displayUser(profileIndex.value, a);
    });

    const sessionAvatar = computed(() => {
      const a = session.value?.actor;
      if (!a) return { photoUrl: "", initial: "?" };
      return displayAvatar(profileIndex.value, a);
    });

    watch(
      () => session.value,
      (s) => {
        if (s === undefined) return;
        syncLastReadMapFromStorage(s?.actor ?? null);
      },
      { immediate: true },
    );

    const myTheme = computed(() => {
      const a = session.value?.actor;
      if (!a) return "light";
      const p = getProfile(profileIndex.value, a);
      return p?.theme === "dark" ? "dark" : "light";
    });

    /** While Settings is open, live-preview theme from the radio; otherwise saved profile theme. */
    const shellIsDark = computed(() => {
      if (settingsOpen.value && session.value?.actor) {
        return settingsTheme.value === "dark";
      }
      return myTheme.value === "dark";
    });

    const { objects, isFirstPoll } = useGraffitiDiscover(
      CHATS_CHANNELS,
      chatsChannelSchema,
    );

    const { objects: sidebarMessageObjects } = useGraffitiDiscover(
      MESSAGES_CHANNELS,
      messagesChannelSchema,
    );

    function sidebarChatMeta(chatObj) {
      return mergeChatMeta(chatObj.value.chatId, objects.value);
    }

    function isGroupChatRow(chatObj) {
      return sidebarChatMeta(chatObj).isGroup;
    }

    const chats = computed(() => {
      const byId = new Map();
      for (const obj of objects.value) {
        const v = obj.value;
        if (!v || v.type !== "create_chat") continue;
        const prev = byId.get(v.chatId);
        const prevAt = prev?.value?.createdAt ?? 0;
        const at = v.createdAt ?? 0;
        if (!prev || at >= prevAt) byId.set(v.chatId, obj);
      }
      return [...byId.values()].sort(
        (a, b) => (b.value.createdAt ?? 0) - (a.value.createdAt ?? 0),
      );
    });

    const sidebarSearch = ref("");
    const sidebarFilter = ref("all");

    const latestMessageByChatId = computed(() => {
      const map = new Map();
      for (const o of sidebarMessageObjects.value) {
        const v = o.value;
        if (!v || v.type !== "send_message" || !v.chatId) continue;
        const prev = map.get(v.chatId);
        const prevAt = prev?.value?.createdAt ?? -1;
        const at = v.createdAt ?? 0;
        if (!prev || at >= prevAt) map.set(v.chatId, o);
      }
      return map;
    });

    const messageCountByChatId = computed(() => {
      const m = new Map();
      for (const o of sidebarMessageObjects.value) {
        const v = o.value;
        if (v?.type !== "send_message" || !v.chatId) continue;
        m.set(v.chatId, (m.get(v.chatId) ?? 0) + 1);
      }
      return m;
    });

    function chatSidebarMetaLine(chatObj) {
      const cid = chatObj.value.chatId;
      const meta = sidebarChatMeta(chatObj);
      const mem = meta.members?.length ?? 0;
      const mc = messageCountByChatId.value.get(cid) ?? 0;
      return `${mem} member${mem === 1 ? "" : "s"} · ${mc} message${mc === 1 ? "" : "s"}`;
    }

    function chatHasUnreadLike(chatId, actor) {
      if (!actor) return false;
      const lastRead = lastReadAtByChatId.value[chatId] ?? 0;
      for (const o of sidebarMessageObjects.value) {
        const v = o.value;
        if (
          v?.type === "send_message" &&
          v.chatId === chatId &&
          v.createdBy !== actor &&
          (v.createdAt ?? 0) > lastRead
        ) {
          return true;
        }
      }
      return false;
    }

    function matchesSidebarSearch(chatObj, query) {
      const meta = sidebarChatMeta(chatObj);
      const q = query.trim().toLowerCase();
      if (!q) return true;
      const name = (meta.name && String(meta.name).toLowerCase()) || "";
      const id = (meta.roomId && String(meta.roomId).toLowerCase()) || "";
      return name.includes(q) || id.includes(q);
    }

    function chatPreviewLine(chatObj) {
      if (session.value == null || !session.value?.actor) {
        return "";
      }
      const meta = sidebarChatMeta(chatObj);
      if (!canAccessChat(meta, session.value.actor)) {
        return "";
      }
      const cid = chatObj.value.chatId;
      const latest = latestMessageByChatId.value.get(cid);
      if (latest?.value) {
        const line = messagePreviewLabel(latest.value);
        if (line) {
          return line.length > 80 ? line.slice(0, 77) + "…" : line;
        }
      }
      const short =
        typeof cid === "string" && cid.length > 8
          ? cid.slice(0, 8) + "…"
          : cid || "";
      return `Room ${short}`;
    }

    const visibleChats = computed(() => {
      if (session.value == null) {
        return [];
      }
      const actor = session.value?.actor;
      let list = chats.value.filter((obj) => {
        const meta = sidebarChatMeta(obj);
        return canAccessChat(meta, actor);
      });
      list = list.filter((obj) =>
        matchesSidebarSearch(obj, sidebarSearch.value),
      );
      const f = sidebarFilter.value;
      if (f === "groups") {
        list = list.filter((obj) => isGroupChatRow(obj));
      } else if (f === "unread") {
        if (!actor) return [];
        list = list.filter((obj) =>
          chatHasUnreadLike(obj.value.chatId, actor),
        );
      }
      return list;
    });

    const sidebarEmptyHint = computed(() => {
      if (sidebarFilter.value === "unread" && !session.value?.actor) {
        return "Sign in to see unread chats.";
      }
      return "No chats match this filter.";
    });

    function setSidebarFilter(v) {
      sidebarFilter.value = v;
    }

    /** Sidebar list flash when search/filter updates (short UI feedback). */
    const sidebarListFlash = ref(false);
    let sidebarListFlashTimer = null;
    let sidebarSearchFlashDebounce = null;

    function triggerSidebarListFlash() {
      if (sidebarListFlashTimer != null) {
        clearTimeout(sidebarListFlashTimer);
        sidebarListFlashTimer = null;
      }
      sidebarListFlash.value = false;
      nextTick(() => {
        sidebarListFlash.value = true;
        sidebarListFlashTimer = window.setTimeout(() => {
          sidebarListFlash.value = false;
          sidebarListFlashTimer = null;
        }, 380);
      });
    }

    watch(sidebarFilter, () => {
      triggerSidebarListFlash();
    });

    watch(sidebarSearch, () => {
      if (sidebarSearchFlashDebounce != null) {
        clearTimeout(sidebarSearchFlashDebounce);
      }
      sidebarSearchFlashDebounce = window.setTimeout(() => {
        sidebarSearchFlashDebounce = null;
        triggerSidebarListFlash();
      }, 420);
    });

    onBeforeUnmount(() => {
      if (sidebarListFlashTimer != null) clearTimeout(sidebarListFlashTimer);
      if (sidebarSearchFlashDebounce != null) {
        clearTimeout(sidebarSearchFlashDebounce);
      }
    });

    async function onLogin() {
      await graffiti.login();
    }

    async function onLogout() {
      const s = session.value;
      if (s) await graffiti.logout(s);
    }

    function openSettings() {
      const s = session.value;
      if (s?.actor) {
        const p = getProfile(profileIndex.value, s.actor);
        const defName = defaultUsernameForActor(s.actor);
        if (p) {
          const u = typeof p.username === "string" ? p.username.trim() : "";
          settingsUsername.value = u || defName;
          settingsPhotoUrl.value =
            typeof p.photoUrl === "string" ? p.photoUrl : "";
          settingsTheme.value = p.theme === "dark" ? "dark" : "light";
        } else {
          settingsUsername.value = defName;
          settingsPhotoUrl.value = "";
          settingsTheme.value = "light";
        }
      }
      settingsError.value = "";
      settingsSnapshot.value = JSON.stringify({
        u: settingsUsername.value,
        p: settingsPhotoUrl.value,
        t: settingsTheme.value,
      });
      settingsOpen.value = true;
    }

    function settingsFormDirty() {
      if (!settingsSnapshot.value) return false;
      return (
        JSON.stringify({
          u: settingsUsername.value,
          p: settingsPhotoUrl.value,
          t: settingsTheme.value,
        }) !== settingsSnapshot.value
      );
    }

    function closeSettings() {
      if (settingsFormDirty()) {
        if (!window.confirm("Discard your profile and theme changes?")) return;
      }
      settingsOpen.value = false;
      settingsSnapshot.value = "";
    }

    async function copySessionMemberId() {
      const a = session.value?.actor;
      if (!a) return;
      const ok = await copyTextToClipboard(a);
      if (!ok) alert("Could not copy your member ID.");
    }

    async function saveSettings() {
      const s = session.value;
      if (!s?.actor) return;
      settingsBusy.value = true;
      settingsError.value = "";
      try {
        const uname = settingsUsername.value.trim();
        const usernameToSave = uname || defaultUsernameForActor(s.actor);
        await graffiti.post(
          {
            value: {
              type: "set_profile",
              actor: s.actor,
              username: usernameToSave,
              photoUrl: settingsPhotoUrl.value.trim(),
              theme: settingsTheme.value === "dark" ? "dark" : "light",
              updatedAt: Date.now(),
            },
            channels: PROFILES_CHANNELS,
          },
          s,
        );
        settingsSnapshot.value = "";
        settingsOpen.value = false;
      } catch (e) {
        console.error(e);
        settingsError.value = "Could not save settings.";
      } finally {
        settingsBusy.value = false;
      }
    }

    const settingsPhotoFileInputRef = ref(null);

    function pickSettingsPhoto() {
      settingsError.value = "";
      settingsPhotoFileInputRef.value?.click();
    }

    function clearSettingsPhoto() {
      settingsError.value = "";
      settingsPhotoUrl.value = "";
      const el = settingsPhotoFileInputRef.value;
      if (el) el.value = "";
    }

    async function onSettingsPhotoFileChange(e) {
      const input = e.target;
      const file = input.files?.[0];
      settingsError.value = "";
      if (!file) return;
      if (!file.type.startsWith("image/")) {
        settingsError.value = "Choose an image file.";
        input.value = "";
        return;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        settingsError.value = "Image must be under 2 MB.";
        input.value = "";
        return;
      }
      try {
        settingsPhotoUrl.value = await readFileAsDataUrl(file);
      } catch (err) {
        console.error(err);
        settingsError.value = "Could not read the image.";
      } finally {
        input.value = "";
      }
    }

    return {
      session,
      onLogin,
      onLogout,
      chats,
      isFirstPoll,
      isSidebarChatActive,
      sessionDisplayName,
      sessionAvatar,
      myTheme,
      shellIsDark,
      chatHasUnreadLike,
      settingsOpen,
      settingsUsername,
      settingsPhotoUrl,
      settingsTheme,
      settingsBusy,
      settingsError,
      openSettings,
      closeSettings,
      saveSettings,
      settingsPhotoFileInputRef,
      pickSettingsPhoto,
      clearSettingsPhoto,
      onSettingsPhotoFileChange,
      sidebarSearch,
      sidebarFilter,
      visibleChats,
      sidebarEmptyHint,
      chatPreviewLine,
      chatSidebarMetaLine,
      isGroupChatRow,
      sidebarChatMeta,
      setSidebarFilter,
      sidebarListFlash,
      shortOpaqueId,
      copySessionMemberId,
    };
  },
  template: `
    <div class="chat-app-shell" :class="{ 'theme-dark': shellIsDark }">
      <aside class="sidebar" aria-label="Chats">
        <div class="sidebar-header">
          <h1 class="sidebar-title">
            <router-link to="/">Studio Chats</router-link>
          </h1>
          <div class="sidebar-session">
            <template v-if="session === undefined">
              <span>Loading…</span>
            </template>
            <template v-else-if="session === null">
              <span>Signed out</span>
              <button type="button" class="btn btn-primary" @click="onLogin">Log in</button>
            </template>
            <template v-else>
              <div class="sidebar-user-block">
                <div class="sidebar-user-avatar">
                  <img
                    v-if="sessionAvatar.photoUrl"
                    :src="sessionAvatar.photoUrl"
                    alt=""
                    class="sidebar-user-avatar-img"
                  />
                  <div v-else class="sidebar-user-avatar-fallback">{{ sessionAvatar.initial }}</div>
                </div>
                <div class="sidebar-user-text">
                  <span class="sidebar-display-name">{{ sessionDisplayName }}</span>
                  <div class="sidebar-id-row">
                    <code class="sidebar-actor-id" :title="session.actor">{{ shortOpaqueId(session.actor) }}</code>
                    <button
                      type="button"
                      class="btn-copy-id btn-copy-id--sidebar"
                      title="Copy full member ID"
                      @click="copySessionMemberId"
                    >
                      Copy ID
                    </button>
                  </div>
                </div>
              </div>
              <button type="button" class="btn btn-ghost" @click="onLogout">Log out</button>
            </template>
          </div>
          <router-link to="/newchat" class="sidebar-new" active-class="router-link-active">
            New Chat
          </router-link>
        </div>
        <div class="sidebar-chats">
          <div class="sidebar-toolbar">
            <label class="sidebar-search-wrap">
              <span class="visually-hidden">Search chats</span>
              <input
                v-model="sidebarSearch"
                type="search"
                class="sidebar-search-input"
                placeholder="Search chats"
                autocomplete="off"
              />
            </label>
            <div class="sidebar-filter-chips" role="tablist" aria-label="Chat filters">
              <button
                type="button"
                role="tab"
                :aria-selected="sidebarFilter === 'all'"
                :class="['sidebar-chip', { 'is-active': sidebarFilter === 'all' }]"
                @click="setSidebarFilter('all')"
              >
                All
              </button>
              <button
                type="button"
                role="tab"
                :aria-selected="sidebarFilter === 'unread'"
                :class="['sidebar-chip', { 'is-active': sidebarFilter === 'unread' }]"
                @click="setSidebarFilter('unread')"
              >
                Unread
              </button>
              <button
                type="button"
                role="tab"
                :aria-selected="sidebarFilter === 'groups'"
                :class="['sidebar-chip', { 'is-active': sidebarFilter === 'groups' }]"
                @click="setSidebarFilter('groups')"
              >
                Groups
              </button>
            </div>
          </div>
          <p v-if="isFirstPoll && chats.length === 0" class="sidebar-hint">Loading chats…</p>
          <p v-else-if="chats.length === 0" class="sidebar-hint">No chats yet. Use New Chat.</p>
          <p v-else-if="visibleChats.length === 0" class="sidebar-hint">{{ sidebarEmptyHint }}</p>
          <ul v-else class="chat-list" :class="{ 'sidebar-list--flash': sidebarListFlash }">
            <li v-for="obj in visibleChats" :key="obj.url">
              <router-link
                :to="'/chat/' + obj.value.chatId"
                :class="[
                  'chat-row',
                  {
                    'is-active': isSidebarChatActive(obj.value.chatId),
                    'chat-row--group': isGroupChatRow(obj),
                    'chat-row--unread': session?.actor && chatHasUnreadLike(obj.value.chatId, session.actor),
                  },
                ]"
              >
                <div
                  class="chat-avatar"
                  :class="{ 'chat-avatar--group': isGroupChatRow(obj) }"
                >
                  <img
                    v-if="sidebarChatMeta(obj).photoUrl"
                    :src="sidebarChatMeta(obj).photoUrl"
                    alt=""
                    class="chat-avatar-img"
                  />
                  <span v-else-if="isGroupChatRow(obj)" class="chat-avatar-group-ico" aria-hidden="true">👥</span>
                  <template v-else>{{ (sidebarChatMeta(obj).name || obj.value.chatId || '?').slice(0, 1).toUpperCase() }}</template>
                </div>
                <div class="chat-row-body">
                  <div class="chat-row-title-row">
                    <span class="chat-row-title">{{ sidebarChatMeta(obj).name }}</span>
                    <span
                      v-if="session?.actor && chatHasUnreadLike(obj.value.chatId, session.actor)"
                      class="chat-row-unread-dot"
                      title="Unread"
                      aria-label="Unread"
                    ></span>
                    <span v-if="isGroupChatRow(obj)" class="chat-row-group-tag">Group</span>
                  </div>
                  <div class="chat-row-preview">{{ chatPreviewLine(obj) }}</div>
                  <div v-if="session?.actor" class="chat-row-meta">{{ chatSidebarMetaLine(obj) }}</div>
                </div>
              </router-link>
            </li>
          </ul>
        </div>
        <div class="sidebar-footer">
          <button
            type="button"
            class="sidebar-settings-btn"
            aria-label="Settings"
            title="Settings"
            @click="openSettings"
          >
            ⚙
          </button>
          <router-link to="/about" class="sidebar-footer-link">About</router-link>
        </div>
      </aside>
      <main class="chat-panel">
        <router-view />
      </main>

      <div
        v-if="settingsOpen"
        class="settings-overlay"
        role="presentation"
        @click.self="closeSettings"
      >
        <div class="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
          <h2 id="settings-title" class="settings-modal-title">Settings</h2>

          <template v-if="session && session.actor">
            <section class="settings-section">
              <h3 class="settings-section-title">Profile</h3>
              <div class="settings-avatar-preview">
                <img
                  v-if="settingsPhotoUrl.trim()"
                  :src="settingsPhotoUrl.trim()"
                  alt=""
                  class="settings-avatar-preview-img"
                />
                <div v-else class="settings-avatar-preview-fallback">
                  {{ (settingsUsername.trim() || session.actor || '?').slice(0, 1).toUpperCase() }}
                </div>
              </div>
              <label class="settings-label">
                Username
                <input v-model="settingsUsername" type="text" autocomplete="nickname" class="settings-input" />
              </label>
              <div class="settings-label settings-photo-upload">
                <span class="settings-label-text">Profile photo</span>
                <input
                  ref="settingsPhotoFileInputRef"
                  type="file"
                  class="visually-hidden"
                  accept="image/*"
                  tabindex="-1"
                  @change="onSettingsPhotoFileChange"
                />
                <div class="settings-photo-actions">
                  <button type="button" class="btn btn-ghost settings-photo-pick" @click="pickSettingsPhoto">
                    Choose photo…
                  </button>
                  <button
                    v-if="settingsPhotoUrl.trim()"
                    type="button"
                    class="btn btn-ghost settings-photo-clear"
                    @click="clearSettingsPhoto"
                  >
                    Remove
                  </button>
                </div>
                <p class="settings-photo-hint">JPEG, PNG, GIF, or WebP · max 2 MB · stored as data in your profile record.</p>
              </div>
              <fieldset class="settings-fieldset">
                <legend class="settings-legend">Theme</legend>
                <label class="settings-radio">
                  <input v-model="settingsTheme" type="radio" value="light" />
                  Light
                </label>
                <label class="settings-radio">
                  <input v-model="settingsTheme" type="radio" value="dark" />
                  Dark
                </label>
              </fieldset>
              <p class="settings-theme-hint">Theme preview updates immediately. Save to keep it.</p>
              <p v-if="settingsError" class="settings-error">{{ settingsError }}</p>
              <div class="settings-modal-actions">
                <button type="button" class="btn btn-ghost" @click="closeSettings">Cancel</button>
                <button
                  type="button"
                  class="btn btn-primary"
                  :disabled="settingsBusy"
                  @click="saveSettings"
                >
                  {{ settingsBusy ? 'Saving…' : 'Save' }}
                </button>
              </div>
            </section>
          </template>
          <template v-else-if="session === null">
            <p class="settings-modal-hint">Log in to edit your profile.</p>
            <div class="settings-modal-actions">
              <button type="button" class="btn btn-primary" @click="closeSettings">Close</button>
            </div>
          </template>
          <template v-else>
            <p class="settings-modal-hint">Loading…</p>
            <div class="settings-modal-actions">
              <button type="button" class="btn btn-ghost" @click="closeSettings">Close</button>
            </div>
          </template>
        </div>
      </div>
    </div>
  `,
});

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", name: "home", component: HomeView },
    { path: "/newchat", name: "newchat", component: NewChatView },
    {
      path: "/join/:chatId/:inviteToken",
      name: "join-chat",
      component: JoinChatView,
      props: true,
    },
    {
      path: "/profile/:actorId",
      name: "user-profile",
      component: UserProfileView,
      props: true,
    },
    {
      path: "/chat/:chatId/versions/:versionId",
      name: "design-version-detail",
      component: DesignVersionDetailView,
      props: true,
    },
    {
      path: "/chat/:chatId/versions",
      name: "design-versions",
      component: DesignVersionsView,
      props: true,
    },
    {
      path: "/chat/:chatId/pins",
      name: "chat-pins",
      component: PinnedMessagesView,
      props: true,
    },
    {
      path: "/chat/:chatId",
      name: "chat",
      component: ChatView,
      props: true,
    },
    { path: "/about", name: "about", component: AboutView },
  ],
});

try {
  const app = createApp(App);
  app.config.errorHandler = (err) => {
    console.error(err);
    const root = document.querySelector("#app");
    if (!root) return;
    root.innerHTML = "";
    const pre = document.createElement("pre");
    pre.style.cssText =
      "padding:1rem;font-family:system-ui,sans-serif;background:#fff0f0;white-space:pre-wrap";
    pre.textContent =
      err && (err.stack || err.message)
        ? err.stack || err.message
        : String(err);
    root.append(pre);
  };
  app
    .use(GraffitiPlugin, { graffiti: new GraffitiDecentralized() })
    .use(router)
    .mount("#app");
  nextTick(() => {
    document.getElementById("static-boot")?.remove();
  });
} catch (err) {
  console.error(err);
  document.getElementById("static-boot")?.remove();
  const root = document.querySelector("#app");
  if (root) {
    root.innerHTML = "";
    const pre = document.createElement("pre");
    pre.style.cssText = "padding:1rem;font-family:monospace;white-space:pre-wrap";
    pre.textContent =
      err && (err.stack || err.message) ? err.stack || err.message : String(err);
    root.append(pre);
  }
}
