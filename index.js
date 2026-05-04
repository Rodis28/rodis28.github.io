import { createApp, defineComponent, computed, ref, nextTick } from "vue";
import {
  createRouter,
  createWebHashHistory,
  RouterView,
  RouterLink,
  useRouter,
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

const CHATS_CHANNELS = ["chats"];
const MESSAGES_CHANNELS = ["messages"];

const MessageBubble = defineComponent({
  name: "MessageBubble",
  props: {
    message: { type: Object, required: true },
    isOwn: { type: Boolean, default: false },
  },
  setup() {
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
    return { formatTime };
  },
  template: `
    <div class="bubble" :class="isOwn ? 'bubble--own' : 'bubble--other'">
      <div v-if="!isOwn" class="who">{{ message.value.createdBy }}</div>
      <p class="text">{{ message.value.content }}</p>
      <div class="bubble-meta">
        <span class="when">{{ formatTime(message.value.createdAt) }}</span>
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

    const thread = computed(() =>
      objects.value
        .filter((o) => o.value?.chatId === props.chatId)
        .sort(
          (a, b) =>
            (a.value.createdAt ?? 0) - (b.value.createdAt ?? 0),
        ),
    );

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

    function onComposerKeydown(e) {
      if (e.key !== "Enter" || e.shiftKey) return;
      e.preventDefault();
      send();
    }

    const headerInitial = computed(() => {
      const n = chatName.value;
      if (typeof n === "string" && n.length > 0) {
        return n.slice(0, 1).toUpperCase();
      }
      const id = props.chatId;
      return (id && id[0] ? id[0] : "?").toUpperCase();
    });

    return {
      session,
      content,
      busy,
      error,
      chatName,
      headerInitial,
      thread,
      isFirstPoll,
      send,
      onComposerKeydown,
    };
  },
  template: `
    <div class="chat-room">
      <header class="chat-header">
        <div class="chat-header-avatar" aria-hidden="true">{{ headerInitial }}</div>
        <div class="chat-header-text">
          <h2 class="chat-header-title">{{ chatName || 'Chat' }}</h2>
          <p class="chat-header-sub">Room <code>{{ chatId }}</code></p>
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
            />
          </div>
        </div>
      </div>

      <footer class="chat-composer">
        <p v-if="session === undefined" class="composer-hint">Loading session…</p>
        <p v-else-if="session === null" class="composer-hint">Log in to send a message.</p>
        <template v-else>
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
          <p v-if="error" class="composer-error">{{ error }}</p>
        </template>
      </footer>
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
    const session = useGraffitiSession();
    const graffiti = useGraffiti();

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

    async function onLogin() {
      await graffiti.login();
    }

    async function onLogout() {
      const s = session.value;
      if (s) await graffiti.logout(s);
    }

    return { session, onLogin, onLogout, chats, isFirstPoll };
  },
  template: `
    <div class="chat-app-shell">
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
              <span>As <code>{{ session.actor }}</code></span>
              <button type="button" class="btn btn-ghost" @click="onLogout">Log out</button>
            </template>
          </div>
          <router-link to="/newchat" class="sidebar-new" active-class="router-link-active">
            New Chat
          </router-link>
        </div>
        <div class="sidebar-chats">
          <p v-if="isFirstPoll && chats.length === 0" class="sidebar-hint">Loading chats…</p>
          <p v-else-if="chats.length === 0" class="sidebar-hint">No chats yet. Use New Chat.</p>
          <ul v-else class="chat-list">
            <li v-for="obj in chats" :key="obj.url">
              <router-link
                :to="'/chat/' + obj.value.chatId"
                class="chat-row"
                active-class="is-active"
              >
                <div class="chat-avatar">{{ (obj.value.name || obj.value.chatId || '?').slice(0, 1).toUpperCase() }}</div>
                <div class="chat-row-body">
                  <div class="chat-row-title">{{ obj.value.name }}</div>
                  <div class="chat-row-preview">Room {{ obj.value.chatId.slice(0, 8) }}…</div>
                </div>
              </router-link>
            </li>
          </ul>
        </div>
        <div class="sidebar-footer">
          <router-link to="/about">About</router-link>
        </div>
      </aside>
      <main class="chat-panel">
        <router-view />
      </main>
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
