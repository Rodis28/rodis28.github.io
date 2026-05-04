import {
  createApp,
  defineComponent,
  computed,
  ref,
  nextTick,
  onBeforeUnmount,
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

/** create_chat, update_chat_profile, add_chat_member on the chats channel */
const chatsChannelSchema = {
  properties: {
    value: {
      oneOf: [
        chatSchema.properties.value,
        updateChatProfileSchema.properties.value,
        addChatMemberSchema.properties.value,
      ],
    },
  },
};

const messageSchema = {
  properties: {
    value: {
      required: ["type", "messageId", "chatId", "content", "createdAt", "createdBy"],
      properties: {
        type: { const: "send_message" },
        messageId: { type: "string" },
        chatId: { type: "string" },
        content: { type: "string" },
        createdAt: { type: "number" },
        createdBy: { type: "string" },
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

function displayUser(profileIndex, actor) {
  const p = getProfile(profileIndex, actor);
  if (p?.username != null && String(p.username).trim() !== "") {
    return String(p.username).trim();
  }
  const s = String(actor);
  return s.length > 8 ? s.slice(0, 8) + "…" : s;
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
  return {
    name,
    photoUrl,
    members,
    createdBy: bestCreate?.createdBy ?? null,
    createdAt: bestCreate?.createdAt ?? null,
    roomId: chatId,
    isGroup: members.length > 2,
  };
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
  },
  emits: [
    "toggle-actions-menu",
    "close-actions-menu",
    "pin",
    "unpin",
    "hide-local",
  ],
  setup(props, { emit }) {
    const messageKind = computed(
      () => props.message.value?.kind || "text",
    );

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
      alert("Reply — coming soon.");
      closeMenu();
    }

    function onReact() {
      alert("Reactions — coming soon.");
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

    function onForward() {
      alert("Forward — coming soon.");
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
      emit("hide-local", props.message);
      closeMenu();
    }

    function onSelectMessages() {
      alert("Select messages — coming soon.");
      closeMenu();
    }

    function onPollVote() {
      alert("Voting — coming soon.");
    }

    return {
      messageKind,
      formatTime,
      formatBytes,
      toggleMenu,
      onReply,
      onReact,
      onPin,
      onUnpin,
      onForward,
      onCopy,
      onDelete,
      onSelectMessages,
      onPollVote,
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

          <template v-if="messageKind === 'text'">
            <p class="text">{{ message.value.content }}</p>
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
                @click="onPollVote"
              >
                {{ opt }}
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
            :aria-expanded="actionsMenuOpen"
            aria-label="Message actions"
            @click.stop="toggleMenu"
          >
            ⋯
          </button>
          <div
            v-show="actionsMenuOpen"
            class="bubble-menu bubble-menu--rich"
            role="menu"
            @click.stop
          >
            <button type="button" role="menuitem" class="bubble-menu-row" @click="onReply">
              <span class="bubble-menu-ico" aria-hidden="true">↩</span>
              Reply
            </button>
            <button type="button" role="menuitem" class="bubble-menu-row" @click="onReact">
              <span class="bubble-menu-ico" aria-hidden="true">🙂</span>
              React
            </button>
            <button
              v-if="!isPinned"
              type="button"
              role="menuitem"
              class="bubble-menu-row"
              @click="onPin"
            >
              <span class="bubble-menu-ico" aria-hidden="true">📌</span>
              Pin
            </button>
            <button v-else type="button" role="menuitem" class="bubble-menu-row" @click="onUnpin">
              <span class="bubble-menu-ico" aria-hidden="true">📍</span>
              Unpin
            </button>
            <button type="button" role="menuitem" class="bubble-menu-row" @click="onForward">
              <span class="bubble-menu-ico" aria-hidden="true">↪</span>
              Forward
            </button>
            <button type="button" role="menuitem" class="bubble-menu-row" @click="onCopy">
              <span class="bubble-menu-ico" aria-hidden="true">📋</span>
              Copy
            </button>
            <div class="bubble-menu-divider" role="separator"></div>
            <button
              type="button"
              role="menuitem"
              class="bubble-menu-row bubble-menu-row--danger"
              @click="onDelete"
            >
              <span class="bubble-menu-ico" aria-hidden="true">🗑</span>
              Delete
            </button>
            <div class="bubble-menu-divider" role="separator"></div>
            <button type="button" role="menuitem" class="bubble-menu-row" @click="onSelectMessages">
              <span class="bubble-menu-ico" aria-hidden="true">✓</span>
              Select messages
            </button>
          </div>
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
    const content = ref("");
    const busy = ref(false);
    const error = ref("");
    /** Which message's ⋯ menu is open (messageId), or null */
    const openActionsMessageId = ref(null);
    /** Locally hidden message IDs for this session only (Delete menu) */
    const hiddenLocalMessageIds = ref(new Set());

    const { objects: chatObjects } = useGraffitiDiscover(
      CHATS_CHANNELS,
      chatsChannelSchema,
    );

    const chatMeta = computed(() =>
      mergeChatMeta(props.chatId, chatObjects.value),
    );
    const chatName = computed(() => chatMeta.value.name || "Chat");
    const headerPhotoUrl = computed(() => chatMeta.value.photoUrl || "");

    const chatInfoOpen = ref(false);
    const editChatName = ref("");
    const editPhotoUrl = ref("");
    const newMemberActor = ref("");
    const chatInfoBusy = ref(false);
    const chatInfoError = ref("");
    const chatInfoSearchQuery = ref("");

    function openChatInfo() {
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

    async function saveChatProfile() {
      const s = session.value;
      if (!s?.actor) {
        chatInfoError.value = "Log in to save.";
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
      const actor = newMemberActor.value.trim();
      if (!actor) {
        chatInfoError.value = "Enter an actor ID.";
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
      messageSchema,
      undefined,
      true,
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

    const thread = computed(() => {
      const hidden = hiddenLocalMessageIds.value;
      return objects.value
        .filter((o) => o.value?.chatId === props.chatId)
        .filter((o) => !hidden.has(o.value.messageId))
        .sort(
          (a, b) =>
            (a.value.createdAt ?? 0) - (b.value.createdAt ?? 0),
        );
    });

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
      if (!s?.actor) return;
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
      if (!s?.actor) return;
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

    async function send() {
      const text = content.value.trim();
      if (!text) return;
      const s = session.value;
      if (!s?.actor) {
        error.value = "Log in to send messages.";
        return;
      }
      const ok = await postSendMessage({
        type: "send_message",
        messageId: crypto.randomUUID(),
        chatId: props.chatId,
        content: text,
        kind: "text",
        createdAt: Date.now(),
        createdBy: s.actor,
      });
      if (ok) content.value = "";
    }

    function onComposerKeydown(e) {
      if (e.key !== "Enter" || e.shiftKey) return;
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
      hideMessageLocally,
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
    };
  },
  template: `
    <div class="chat-room">
      <header class="chat-header">
        <button
          type="button"
          class="chat-header-trigger"
          aria-label="Open chat info"
          @click="openChatInfo"
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
            <p class="chat-header-sub">Room <code>{{ chatId }}</code></p>
          </div>
        </button>
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

      <div class="chat-messages-wrap">
        <p v-if="isFirstPoll && thread.length === 0" class="chat-messages-status">Loading messages…</p>
        <p v-else-if="thread.length === 0" class="chat-messages-status">No messages yet. Say hello below.</p>
        <div v-else class="chat-messages">
          <div
            v-for="m in thread"
            :key="m.url"
            class="message-row"
            :class="session?.actor === m.value.createdBy ? 'message-row--own' : 'message-row--other'"
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
              @toggle-actions-menu="toggleActionsMenu(m.value.messageId)"
              @close-actions-menu="closeActionsMenu"
              @pin="onPinMessage"
              @unpin="onUnpinMessage"
              @hide-local="hideMessageLocally"
            />
          </div>
        </div>
      </div>

      <footer class="chat-composer">
        <p v-if="session === undefined" class="composer-hint">Loading session…</p>
        <p v-else-if="session === null" class="composer-hint">Log in to send a message.</p>
        <template v-else>
          <div class="composer-inner">
            <div class="composer-attach-col" data-composer-attachment-root>
              <button
                type="button"
                class="composer-attach-btn"
                aria-label="Attachments"
                :aria-expanded="attachmentMenuOpen"
                @click.stop="toggleAttachmentMenu"
              >
                +
              </button>
              <div
                v-show="attachmentMenuOpen"
                class="composer-attach-menu"
                role="menu"
                @click.stop
              >
                <button type="button" class="composer-attach-row" role="menuitem" @click="pickFile">
                  <span class="composer-attach-ico" aria-hidden="true">📄</span>
                  File
                </button>
                <button type="button" class="composer-attach-row" role="menuitem" @click="pickMedia">
                  <span class="composer-attach-ico" aria-hidden="true">🖼</span>
                  Photos/videos
                </button>
                <button type="button" class="composer-attach-row" role="menuitem" @click="openPollModal">
                  <span class="composer-attach-ico" aria-hidden="true">📊</span>
                  Poll
                </button>
                <button type="button" class="composer-attach-row" role="menuitem" @click="openContactModal">
                  <span class="composer-attach-ico" aria-hidden="true">👤</span>
                  Contact
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
                v-model="content"
                class="composer-input"
                placeholder="Type a message"
                aria-label="Message"
                rows="1"
                @keydown="onComposerKeydown"
              ></textarea>
              <button type="submit" class="composer-send btn btn-primary" :disabled="busy">
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
        v-if="chatInfoOpen"
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
              <div class="chat-info-hero-avatar">
                <img
                  v-if="chatMeta.photoUrl"
                  :src="chatMeta.photoUrl"
                  alt=""
                  class="chat-info-hero-img"
                />
                <div v-else class="chat-info-hero-fallback" aria-hidden="true">{{ headerInitial }}</div>
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
              <div class="chat-info-row">
                <span class="chat-info-k">Room ID</span>
                <code class="chat-info-v">{{ chatId }}</code>
              </div>
              <div v-if="chatMeta.createdBy" class="chat-info-row">
                <span class="chat-info-k">Created by</span>
                <span class="chat-info-v">{{ senderLabel(chatMeta.createdBy) }}</span>
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

            <section class="chat-info-section" aria-label="Members">
              <h3 class="chat-info-section-title">Members</h3>
              <p v-if="chatMeta.members.length === 0" class="chat-info-muted">Members not available yet.</p>
              <ul v-else class="chat-info-member-list">
                <li
                  v-for="actor in chatMeta.members"
                  :key="actor"
                  class="chat-info-member-row"
                >
                  <div class="chat-info-member-ava">
                    <img
                      v-if="bubbleAvatar(actor).photoUrl"
                      :src="bubbleAvatar(actor).photoUrl"
                      alt=""
                      class="chat-info-member-img"
                    />
                    <span v-else class="chat-info-member-init">{{ bubbleAvatar(actor).initial }}</span>
                  </div>
                  <div class="chat-info-member-text">
                    <span class="chat-info-member-name">{{ senderLabel(actor) }}</span>
                    <code class="chat-info-member-id">{{ actor }}</code>
                  </div>
                </li>
              </ul>
              <p
                v-if="chatMeta.members.length === 0 && session?.actor"
                class="chat-info-you"
              >
                <span class="chat-info-label-inline">You</span>
                {{ senderLabel(session.actor) }}
                <code class="chat-info-member-id">{{ session.actor }}</code>
              </p>
              <div v-if="session?.actor" class="chat-info-add-row">
                <input
                  v-model="newMemberActor"
                  type="text"
                  class="chat-info-input chat-info-input--inline"
                  placeholder="Actor ID to add"
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
  props: {
    chatId: { type: String, required: true },
  },
  setup(props) {
    const session = useGraffitiSession();
    const graffiti = useGraffiti();
    const router = useRouter();
    const search = ref("");
    const sortOrder = ref("newest");

    const { objects: chatObjects } = useGraffitiDiscover(
      CHATS_CHANNELS,
      chatsChannelSchema,
    );

    const chatMeta = computed(() =>
      mergeChatMeta(props.chatId, chatObjects.value),
    );
    const chatName = computed(() => chatMeta.value.name || "Chat");
    const headerPhotoUrl = computed(() => chatMeta.value.photoUrl || "");

    const { objects: messageObjects } = useGraffitiDiscover(
      MESSAGES_CHANNELS,
      messageSchema,
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

    const rawPinnedRows = computed(() => {
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
          const text = row.message?.value?.content;
          return (
            typeof text === "string" && text.toLowerCase().includes(q)
          );
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
      if (!s?.actor) return;
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

    function goBack() {
      router.push("/chat/" + props.chatId);
    }

    function labelFor(actor) {
      return displayUser(profileIndex.value, actor);
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
      unpinRow,
      goBack,
    };
  },
  template: `
    <div class="chat-room chat-room--pins-only">
      <header class="chat-header">
        <div class="chat-header-avatar-slot">
          <img
            v-if="headerPhotoUrl"
            :src="headerPhotoUrl"
            alt=""
            class="chat-header-avatar chat-header-avatar--img"
          />
          <div v-else class="chat-header-avatar" aria-hidden="true">{{ headerInitial }}</div>
        </div>
        <div class="chat-header-main">
          <div class="chat-header-text">
            <h2 class="chat-header-title">{{ chatName || 'Chat' }} — Pinned</h2>
            <p class="chat-header-sub">Room <code>{{ chatId }}</code></p>
          </div>
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
        <button type="button" class="btn btn-ghost pinned-back-btn" @click="goBack">Back to chat</button>
      </div>

      <div class="pinned-manager-body">
        <p v-if="rawPinnedRows.length === 0" class="pinned-manager-empty">
          No pinned messages yet. Pin messages from the chat using the ⋯ menu on each bubble.
        </p>
        <p v-else-if="filteredSortedRows.length === 0" class="pinned-manager-empty">
          No pinned messages match your search.
        </p>
        <ul v-else class="pinned-card-list">
          <li
            v-for="row in filteredSortedRows"
            :key="row.messageId + '-' + (row.pin.url || row.pin.value.pinId)"
            class="pinned-card"
          >
            <p class="pinned-card-content">{{ row.message ? row.message.value.content : '— (message not in thread)' }}</p>
            <dl class="pinned-card-meta">
              <div>
                <dt>From</dt>
                <dd>{{ row.message ? labelFor(row.message.value.createdBy) : '—' }}</dd>
              </div>
              <div>
                <dt>Sent</dt>
                <dd>{{ row.message ? formatDateTime(row.message.value.createdAt) : '—' }}</dd>
              </div>
              <div>
                <dt>Pinned</dt>
                <dd>{{ formatDateTime(row.pin.value.pinnedAt) }}</dd>
              </div>
              <div>
                <dt>By</dt>
                <dd>{{ labelFor(row.pin.value.pinnedBy) }}</dd>
              </div>
            </dl>
            <div class="pinned-card-actions">
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
    </div>
  `,
});

const AboutView = defineComponent({
  name: "AboutView",
  template: `
    <div class="chat-panel-static">
      <div class="chat-panel-static-inner">
        <h2>About</h2>
        <p>
          Studio Chats uses Graffiti for shared chats and messages.
        </p>
        <p>
          Pick a room from the list or start a new chat from the sidebar.
        </p>
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

    const myTheme = computed(() => {
      const a = session.value?.actor;
      if (!a) return "light";
      const p = getProfile(profileIndex.value, a);
      return p?.theme === "dark" ? "dark" : "light";
    });

    const { objects, isFirstPoll } = useGraffitiDiscover(
      CHATS_CHANNELS,
      chatsChannelSchema,
    );

    const { objects: sidebarMessageObjects } = useGraffitiDiscover(
      MESSAGES_CHANNELS,
      messageSchema,
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

    function chatHasUnreadLike(chatId, actor) {
      if (!actor) return false;
      for (const o of sidebarMessageObjects.value) {
        const v = o.value;
        if (
          v?.type === "send_message" &&
          v.chatId === chatId &&
          v.createdBy !== actor
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
      let list = chats.value.filter((obj) =>
        matchesSidebarSearch(obj, sidebarSearch.value),
      );
      const f = sidebarFilter.value;
      if (f === "groups") {
        list = list.filter((obj) => isGroupChatRow(obj));
      } else if (f === "unread") {
        const actor = session.value?.actor;
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
        if (p) {
          settingsUsername.value =
            typeof p.username === "string" ? p.username : "";
          settingsPhotoUrl.value =
            typeof p.photoUrl === "string" ? p.photoUrl : "";
          settingsTheme.value = p.theme === "dark" ? "dark" : "light";
        } else {
          settingsUsername.value = "";
          settingsPhotoUrl.value = "";
          settingsTheme.value = "light";
        }
      }
      settingsError.value = "";
      settingsOpen.value = true;
    }

    function closeSettings() {
      settingsOpen.value = false;
    }

    async function saveSettings() {
      const s = session.value;
      if (!s?.actor) return;
      settingsBusy.value = true;
      settingsError.value = "";
      try {
        const uname = settingsUsername.value.trim();
        await graffiti.post(
          {
            value: {
              type: "set_profile",
              actor: s.actor,
              username:
                uname ||
                (String(s.actor).length > 8
                  ? String(s.actor).slice(0, 8) + "…"
                  : String(s.actor)),
              photoUrl: settingsPhotoUrl.value.trim(),
              theme: settingsTheme.value === "dark" ? "dark" : "light",
              updatedAt: Date.now(),
            },
            channels: PROFILES_CHANNELS,
          },
          s,
        );
        settingsOpen.value = false;
      } catch (e) {
        console.error(e);
        settingsError.value = "Could not save settings.";
      } finally {
        settingsBusy.value = false;
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
      settingsOpen,
      settingsUsername,
      settingsPhotoUrl,
      settingsTheme,
      settingsBusy,
      settingsError,
      openSettings,
      closeSettings,
      saveSettings,
      sidebarSearch,
      sidebarFilter,
      visibleChats,
      sidebarEmptyHint,
      chatPreviewLine,
      isGroupChatRow,
      sidebarChatMeta,
      setSidebarFilter,
    };
  },
  template: `
    <div class="chat-app-shell" :class="{ 'theme-dark': myTheme === 'dark' }">
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
                  <code class="sidebar-actor-id" :title="session.actor">{{ session.actor }}</code>
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
          <ul v-else class="chat-list">
            <li v-for="obj in visibleChats" :key="obj.url">
              <router-link
                :to="'/chat/' + obj.value.chatId"
                :class="['chat-row', { 'is-active': isSidebarChatActive(obj.value.chatId), 'chat-row--group': isGroupChatRow(obj) }]"
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
                    <span v-if="isGroupChatRow(obj)" class="chat-row-group-tag">Group</span>
                  </div>
                  <div class="chat-row-preview">{{ chatPreviewLine(obj) }}</div>
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
              <label class="settings-label">
                Photo URL
                <input v-model="settingsPhotoUrl" type="url" autocomplete="off" class="settings-input" placeholder="https://…" />
              </label>
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
