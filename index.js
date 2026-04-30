import { createApp, defineComponent, computed, ref, nextTick } from "vue";
import {
  createRouter,
  createWebHashHistory,
  RouterView,
  RouterLink,
  useRouter,
} from "vue-router";
import { GraffitiLocal } from "@graffiti-garden/implementation-local";
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
      },
    },
  },
};

const messageSchema = {
  properties: {
    value: {
      required: ["type", "messageId", "chatId", "content"],
      properties: {
        type: { const: "send_message" },
        messageId: { type: "string" },
        chatId: { type: "string" },
        content: { type: "string" },
        createdAt: { type: "number" },
        createdBy: { type: "string" },
      },
    },
  },
};

const pinSchema = {
  properties: {
    value: {
      required: [
        "type",
        "pinId",
        "chatId",
        "messageId",
        "pinnedAt",
        "pinnedBy",
      ],
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

const CHATS_CHANNELS = ["chats"];
const MESSAGES_CHANNELS = ["messages"];
const PINS_CHANNELS = ["pins"];

const MessageBubble = defineComponent({
  name: "MessageBubble",
  props: {
    message: { type: Object, required: true },
    canPin: { type: Boolean, default: false },
    isPinned: { type: Boolean, default: false },
  },
  emits: ["pin"],
  setup() {
    function formatTime(ts) {
      if (ts == null) return "";
      try {
        return new Date(ts).toLocaleString(undefined, {
          dateStyle: "short",
          timeStyle: "short",
        });
      } catch {
        return "";
      }
    }
    return { formatTime };
  },
  template: `
    <div class="bubble">
      <div class="who">{{ message.value.createdBy }}</div>
      <div class="text">{{ message.value.content }}</div>
      <div class="when">{{ formatTime(message.value.createdAt) }}</div>
      <div v-if="canPin" style="margin-top: 0.5rem">
        <button
          v-if="!isPinned"
          type="button"
          class="ghost"
          @click="$emit('pin', message)"
        >
          Pin
        </button>
        <button v-else type="button" class="ghost" disabled>Pinned</button>
      </div>
    </div>
  `,
});

const HomeView = defineComponent({
  name: "HomeView",
  setup() {
    const { objects, isFirstPoll } = useGraffitiDiscover(
      CHATS_CHANNELS,
      chatSchema,
    );
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
    return { chats, isFirstPoll };
  },
  template: `
    <main class="card">
      <h2>Your chats</h2>
      <p v-if="isFirstPoll && chats.length === 0" class="hint">Loading chats…</p>
      <p v-else-if="chats.length === 0" class="empty">No chats yet. Start one from New Chat.</p>
      <ul v-else class="chat-list">
        <li v-for="obj in chats" :key="obj.url">
          <router-link :to="'/chat/' + obj.value.chatId">
            <div class="name">{{ obj.value.name }}</div>
            <div class="meta">Room ID · {{ obj.value.chatId.slice(0, 8) }}…</div>
          </router-link>
        </li>
      </ul>
    </main>
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
    <main class="card">
      <h2>New chat</h2>
      <p v-if="session === undefined" class="hint">Loading…</p>
      <p v-else-if="session === null" class="hint">Log in from the header to create a chat.</p>
      <form v-else class="stacked" @submit.prevent="submit">
        <label>
          Chat name
          <input v-model="name" type="text" autocomplete="off" placeholder="e.g. Capsule collection — fittings" />
        </label>
        <p v-if="error" class="hint">{{ error }}</p>
        <button type="submit" class="primary" :disabled="busy">{{ busy ? 'Creating…' : 'Create chat' }}</button>
      </form>
    </main>
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

    const { objects: chatObjects } = useGraffitiDiscover(
      CHATS_CHANNELS,
      chatSchema,
    );

    const chatName = computed(() => {
      let bestName = null;
      let bestAt = -Infinity;
      for (const o of chatObjects.value) {
        const v = o.value;
        if (!v || v.type !== "create_chat" || v.chatId !== props.chatId) continue;
        const t = v.createdAt ?? 0;
        if (t >= bestAt) {
          bestAt = t;
          bestName = typeof v.name === "string" ? v.name : null;
        }
      }
      return bestName;
    });

    const { objects, isFirstPoll } = useGraffitiDiscover(
      MESSAGES_CHANNELS,
      messageSchema,
      undefined,
      true,
    );

    const { objects: pinObjects } = useGraffitiDiscover(
      PINS_CHANNELS,
      pinSchema,
    );

    const thread = computed(() =>
      objects.value
        .filter((o) => o.value?.chatId === props.chatId)
        .sort(
          (a, b) =>
            (a.value.createdAt ?? 0) - (b.value.createdAt ?? 0),
        ),
    );

    const pinnedMessageIds = computed(() => {
      const ids = new Set();
      for (const o of pinObjects.value) {
        const v = o.value;
        if (v?.type === "pin_message" && v.chatId === props.chatId) {
          ids.add(v.messageId);
        }
      }
      return ids;
    });

    const pinnedRows = computed(() => {
      const threadById = new Map(
        thread.value.map((m) => [m.value.messageId, m]),
      );
      const pins = pinObjects.value.filter(
        (o) =>
          o.value?.type === "pin_message" &&
          o.value?.chatId === props.chatId,
      );
      const bestPinByMessage = new Map();
      for (const pin of pins) {
        const mid = pin.value.messageId;
        const cur = bestPinByMessage.get(mid);
        if (
          !cur ||
          (pin.value.pinnedAt ?? 0) >= (cur.value.pinnedAt ?? 0)
        ) {
          bestPinByMessage.set(mid, pin);
        }
      }
      return [...bestPinByMessage.values()]
        .sort(
          (a, b) =>
            (b.value.pinnedAt ?? 0) - (a.value.pinnedAt ?? 0),
        )
        .map((pin) => ({
          pin,
          message: threadById.get(pin.value.messageId) ?? null,
        }));
    });

    function formatTime(ts) {
      if (ts == null) return "";
      try {
        return new Date(ts).toLocaleString(undefined, {
          dateStyle: "short",
          timeStyle: "short",
        });
      } catch {
        return "";
      }
    }

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

    async function send() {
      error.value = "";
      const s = session.value;
      if (!s?.actor) {
        error.value = "Log in to send messages.";
        return;
      }
      const text = content.value.trim();
      if (!text) return;
      busy.value = true;
      try {
        await graffiti.post(
          {
            value: {
              type: "send_message",
              messageId: crypto.randomUUID(),
              chatId: props.chatId,
              content: text,
              createdAt: Date.now(),
              createdBy: s.actor,
            },
            channels: MESSAGES_CHANNELS,
          },
          s,
        );
        content.value = "";
      } catch (e) {
        console.error(e);
        error.value = "Message could not be sent.";
      } finally {
        busy.value = false;
      }
    }

    return {
      session,
      content,
      busy,
      error,
      chatName,
      thread,
      isFirstPoll,
      pinnedRows,
      pinnedMessageIds,
      formatTime,
      onPinMessage,
      send,
    };
  },
  template: `
    <main class="card">
      <h2>{{ chatName || 'Chat' }}</h2>
      <p class="hint">Room <code>{{ chatId }}</code></p>

      <div style="margin-bottom: 1.25rem">
        <h3 style="margin: 0 0 0.5rem; font-size: 1rem; font-weight: 600">Pinned messages</h3>
        <p v-if="pinnedRows.length === 0" class="hint">No pinned messages yet.</p>
        <div v-else class="messages" style="max-height: min(36vh, 280px); margin-bottom: 0">
          <div v-for="row in pinnedRows" :key="row.pin.url" class="bubble">
            <template v-if="row.message">
              <div class="who">{{ row.message.value.createdBy }}</div>
              <div class="text">{{ row.message.value.content }}</div>
              <div class="when">{{ formatTime(row.message.value.createdAt) }}</div>
            </template>
            <template v-else>
              <div class="who">Pinned</div>
              <div class="text">Original message is not in this thread.</div>
              <div class="when">{{ formatTime(row.pin.value.pinnedAt) }}</div>
            </template>
          </div>
        </div>
      </div>

      <p v-if="isFirstPoll && thread.length === 0" class="hint">Loading messages…</p>
      <div v-else-if="thread.length === 0" class="empty messages">No messages yet. Say hello below.</div>
      <div v-else class="messages">
        <MessageBubble
          v-for="m in thread"
          :key="m.url"
          :message="m"
          :can-pin="!!session?.actor"
          :is-pinned="pinnedMessageIds.has(m.value.messageId)"
          @pin="onPinMessage"
        />
      </div>
      <p v-if="session === undefined" class="hint">Loading session…</p>
      <p v-else-if="session === null" class="hint">Log in to send a message.</p>
      <form v-else class="stacked" @submit.prevent="send">
        <label>
          Message
          <textarea v-model="content" placeholder="Share feedback, links, or decisions…"></textarea>
        </label>
        <p v-if="error" class="hint">{{ error }}</p>
        <button type="submit" class="primary" :disabled="busy">{{ busy ? 'Sending…' : 'Send' }}</button>
      </form>
    </main>
  `,
});

const AboutView = defineComponent({
  name: "AboutView",
  template: `
    <main class="card about">
      <h2>About</h2>
      <p>
        This app helps fashion design students organize project chats, feedback, and design decisions.
      </p>
      <p>
        Chats and messages are stored with Graffiti so you can keep a lightweight trail of studio conversation alongside your work.
      </p>
    </main>
  `,
});

const App = defineComponent({
  components: { RouterView, RouterLink },
  setup() {
    const session = useGraffitiSession();
    const graffiti = useGraffiti();

    async function onLogin() {
      await graffiti.login();
    }

    async function onLogout() {
      const s = session.value;
      if (s) await graffiti.logout(s);
    }

    return { session, onLogin, onLogout };
  },
  template: `
    <div>
      <header class="app-header">
        <router-link class="brand" to="/">
          <h1>Studio Chats</h1>
          <p>Fashion design project rooms</p>
        </router-link>
        <div class="session">
          <span v-if="session === undefined" class="muted">Loading…</span>
          <template v-else-if="session === null">
            <span class="muted">Signed out</span>
            <button type="button" class="primary" @click="onLogin">Log in</button>
          </template>
          <template v-else>
            <span class="muted">Signed in as <code>{{ session.actor }}</code></span>
            <button type="button" class="ghost" @click="onLogout">Log out</button>
          </template>
        </div>
      </header>
      <nav class="primary">
        <router-link to="/">Home</router-link>
        <router-link to="/newchat">New Chat</router-link>
        <router-link to="/about">About</router-link>
      </nav>
      <router-view style="margin-top:1.25rem;" />
    </div>
  `,
});

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", name: "home", component: HomeView },
    { path: "/newchat", name: "newchat", component: NewChatView },
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
    .use(GraffitiPlugin, { graffiti: new GraffitiLocal() })
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
