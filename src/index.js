const TELEGRAM_API = (token) =>
  `https://api.telegram.org/bot${token}`;

const DEFAULT_SOURCE = "default";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json;charset=UTF-8",
    },
  });
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function normalizeText(text = "") {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function telegram(env, method, body) {
  const response = await fetch(
    `${TELEGRAM_API(env.BOT_TOKEN)}/${method}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  return response.json();
}

async function sendMessage(env, chatId, text, options = {}) {
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...options,
  });
}

async function deleteMessage(env, chatId, messageId) {
  return telegram(env, "deleteMessage", {
    chat_id: chatId,
    message_id: messageId,
  });
}

async function getChatMember(env, channel, userId) {
  return telegram(env, "getChatMember", {
    chat_id: channel,
    user_id: userId,
  });
}

async function isUserJoined(env, userId) {
  try {
    const result = await getChatMember(
      env,
      env.FORCE_JOIN_CHANNEL,
      userId
    );

    if (!result.ok) {
      return false;
    }

    const status = result.result?.status;

    return [
      "creator",
      "administrator",
      "member",
    ].includes(status);
  } catch {
    return false;
  }
}

async function forceJoinKeyboard(env) {
  return {
    inline_keyboard: [
      [
        {
          text: "📢 JOIN CHANNEL",
          url: `https://t.me/${env.FORCE_JOIN_CHANNEL.replace("@", "")}`,
        },
      ],
      [
        {
          text: "✅ I HAVE JOINED",
          callback_data: "check_join",
        },
      ],
    ],
  };
}

async function mainMenu(env) {
  return {
    inline_keyboard: [
      [
        {
          text: "🎬 MOVIE GROUP",
          url: env.MOVIE_GROUP_URL,
        },
        {
          text: "🆘 HELP",
          url: env.HELP_URL,
        },
      ],
      [
        {
          text: "🛍️ FLIPKART / AMAZON OFFERS",
          url: env.OFFERS_URL,
        },
      ],
      [
        {
          text: "👥 REFERRAL",
          callback_data: "referral",
        },
        {
          text: "ℹ️ ABOUT",
          callback_data: "about",
        },
      ],
    ],
  };
}

async function upsertUser(env, user, referralCode = null) {
  if (!user?.id) return;

  const existing = await env.DB.prepare(
    "SELECT user_id FROM users WHERE user_id = ?"
  )
    .bind(user.id)
    .first();

  if (!existing) {
    const code =
      referralCode ||
      Math.random().toString(36).slice(2, 10);

    await env.DB.prepare(
      `INSERT INTO users
      (user_id, username, first_name, joined_at, referral_code)
      VALUES (?, ?, ?, ?, ?)`
    )
      .bind(
        user.id,
        user.username || null,
        user.first_name || null,
        now(),
        code
      )
      .run();
  } else {
    await env.DB.prepare(
      `UPDATE users
       SET username = ?, first_name = ?
       WHERE user_id = ?`
    )
      .bind(
        user.username || null,
        user.first_name || null,
        user.id
      )
      .run();
  }
}

async function searchMovies(env, query) {
  const q = normalizeText(query);

  if (!q) return [];

  const like = `%${q}%`;

  const result = await env.DB.prepare(
    `SELECT *
     FROM movies
     WHERE lower(title) LIKE ?
     ORDER BY created_at DESC
     LIMIT 20`
  )
    .bind(like)
    .all();

  return result.results || [];
}

async function sendSearchResults(env, chatId, query) {
  const results = await searchMovies(env, query);

  if (!results.length) {
    return sendMessage(
      env,
      chatId,
      `❌ <b>NO RESULT FOUND</b>\n\n` +
        `We could not find:\n` +
        `<code>${escapeHtml(query)}</code>\n\n` +
        `Please check the spelling and try again.`
    );
  }

  const buttons = results.map((movie) => [
    {
      text:
        `${movie.title}` +
        (movie.quality ? ` • ${movie.quality}` : ""),
      callback_data: `movie:${movie.id}`,
    },
  ]);

  const resultMessage = await sendMessage(
    env,
    chatId,
    `🔍 <b>SEARCH RESULTS</b>\n\n` +
      `Found ${results.length} result(s) for:\n` +
      `<b>${escapeHtml(query)}</b>`,
    {
      reply_markup: {
        inline_keyboard: buttons,
      },
    }
  );

  await scheduleDelete(
    env,
    chatId,
    resultMessage.result?.message_id
  );

  return resultMessage;
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function scheduleDelete(env, chatId, messageId) {
  if (!messageId) return;

  await env.DB.prepare(
    `INSERT INTO settings (key, value)
     VALUES (?, ?)
     ON CONFLICT(key)
     DO UPDATE SET value = value`
  )
    .bind(
      `delete:${chatId}:${messageId}`,
      String(now() + 300)
    )
    .run();
}

async function getMovie(env, id) {
  return env.DB.prepare(
    `SELECT * FROM movies WHERE id = ?`
  )
    .bind(id)
    .first();
}

function movieDetails(movie) {
  return (
    `🎬 <b>${escapeHtml(movie.title)}</b>\n\n` +
    `🌐 Language: ${escapeHtml(movie.language || "N/A")}\n` +
    `🎞️ Season: ${escapeHtml(movie.season || "Movie")}\n` +
    `🎥 Quality: ${escapeHtml(movie.quality || "N/A")}\n` +
    `📁 File: ${escapeHtml(movie.file_name || "N/A")}`
  );
}

async function deliverMovie(env, chatId, movie) {
  if (movie.source_type === "terabox") {
    const msg = await sendMessage(
      env,
      chatId,
      `${movieDetails(movie)}\n\n🔗 <b>TERABOX LINK</b>`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🔗 OPEN TERABOX",
                url: movie.terabox_url,
              },
            ],
          ],
        },
      }
    );

    await scheduleDelete(
      env,
      chatId,
      msg.result?.message_id
    );

    return msg;
  }

  if (!movie.telegram_file_id) {
    return sendMessage(
      env,
      chatId,
      "❌ Content file is not available."
    );
  }

  let response;

  const caption =
    `${movieDetails(movie)}\n\n` +
    `🎥 <b>ALL GROUP LINKS</b>`;

  const keyboard = {
    inline_keyboard: [
      [
        {
          text: "👉 CLICK HERE",
          url: env.MOVIE_GROUP_URL,
        },
      ],
    ],
  };

  if (movie.source_type === "video") {
    response = await telegram(env, "sendVideo", {
      chat_id: chatId,
      video: movie.telegram_file_id,
      caption,
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  } else {
    response = await telegram(env, "sendDocument", {
      chat_id: chatId,
      document: movie.telegram_file_id,
      caption,
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  }

  if (response.ok && response.result?.message_id) {
    await scheduleDelete(
      env,
      chatId,
      response.result.message_id
    );
  }

  return response;
}

async function handleCallback(env, callback) {
  const data = callback.data;
  const chatId = callback.message?.chat?.id;
  const userId = callback.from?.id;

  await telegram(env, "answerCallbackQuery", {
    callback_query_id: callback.id,
  });

  if (data === "check_join") {
    const joined = await isUserJoined(env, userId);

    if (!joined) {
      await telegram(env, "editMessageText", {
        chat_id: chatId,
        message_id: callback.message.message_id,
        text:
          "❌ <b>You have not joined the channel yet.</b>\n\n" +
          "Please join the channel first.",
        parse_mode: "HTML",
        reply_markup: await forceJoinKeyboard(env),
      });

      return;
    }

    await telegram(env, "editMessageText", {
      chat_id: chatId,
      message_id: callback.message.message_id,
      text:
        "✅ <b>Verified!</b>\n\n" +
        "You can now search and access available content.",
      parse_mode: "HTML",
      reply_markup: await mainMenu(env),
    });

    return;
  }

  if (data === "about") {
    await sendMessage(
      env,
      chatId,
      `<b>🎬 MOVIEDETA BOT</b>\n\n` +
        `🔍 Fast Search\n` +
        `📺 Telegram Source Support\n` +
        `🔗 TeraBox Link Support\n` +
        `🔒 Channel Verification\n` +
        `⚡ Automatic Cleanup\n\n` +
        `<b>Free for everyone.</b>`
    );
    return;
  }

  if (data === "referral") {
    const user = await env.DB.prepare(
      "SELECT referral_code FROM users WHERE user_id = ?"
    )
      .bind(userId)
      .first();

    const code =
      user?.referral_code ||
      Math.random().toString(36).slice(2, 10);

    const link =
      `https://t.me/${env.BOT_USERNAME}?start=${code}`;

    await sendMessage(
      env,
      chatId,
      `<b>👥 YOUR REFERRAL LINK</b>\n\n` +
        `<code>${escapeHtml(link)}</code>`
    );

    return;
  }

  if (data.startsWith("movie:")) {
    const movieId = Number(data.split(":")[1]);

    const movie = await getMovie(env, movieId);

    if (!movie) {
      await sendMessage(
        env,
        chatId,
        "❌ Content not found."
      );
      return;
    }

    const joined = await isUserJoined(env, userId);

    if (!joined) {
      await sendMessage(
        env,
        chatId,
        "🔒 <b>JOIN REQUIRED</b>\n\n" +
          "Please join our channel before accessing this content.",
        {
          reply_markup: await forceJoinKeyboard(env),
        }
      );

      return;
    }

    await deliverMovie(env, chatId, movie);
  }
}

async function processUpdate(env, update) {
  if (update.callback_query) {
    return handleCallback(env, update.callback_query);
  }

  if (update.channel_post) {
    return handleChannelPost(env, update.channel_post);
  }

  if (!update.message) {
    return;
  }

  const message = update.message;
  const chatId = message.chat.id;
  const user = message.from;

  if (user) {
    await upsertUser(env, user);
  }

  if (message.text?.startsWith("/start")) {
    const parts = message.text.split(" ");
    const referralCode = parts[1] || null;

    if (referralCode && user) {
      await upsertUser(env, user, referralCode);
    }

    await sendMessage(
      env,
      chatId,
      `<b>👋 Welcome to MovieDeta Bot!</b>\n\n` +
        `🎬 Search available content quickly.\n` +
        `⚡ Fast • Free • Easy`,
      {
        reply_markup: await mainMenu(env),
      }
    );

    return;
  }

  if (message.text === "/help") {
    await sendMessage(
      env,
      chatId,
      `<b>🆘 HELP</b>\n\nPlease contact support:`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🆘 CONTACT SUPPORT",
                url: env.HELP_URL,
              },
            ],
          ],
        },
      }
    );

    return;
  }

  if (message.chat.type === "group" ||
      message.chat.type === "supergroup") {

    if (!message.text) {
      return;
    }

    const text = message.text.trim();

    if (text.startsWith("/")) {
      return;
    }

    await sendSearchResults(
      env,
      chatId,
      text
    );

    return;
  }
}

async function handleChannelPost(env, post) {
  const source = post.chat.username
    ? `@${post.chat.username}`
    : String(post.chat.id);

  const messageId = post.message_id;

  let sourceType = null;
  let fileId = null;
  let fileName = null;

  if (post.video?.file_id) {
    sourceType = "video";
    fileId = post.video.file_id;
    fileName =
      post.video.file_name ||
      `video_${messageId}.mp4`;
  } else if (post.document?.file_id) {
    sourceType = "telegram";
    fileId = post.document.file_id;
    fileName =
      post.document.file_name ||
      `document_${messageId}`;
  }

  const text =
    post.caption ||
    post.text ||
    "";

  if (!text && !fileId) {
    return;
  }

  const firstLine =
    text
      .split("\n")[0]
      ?.replace(/^🎬\s*/i, "")
      .trim() ||
    fileName ||
    `Content ${messageId}`;

  const title =
    firstLine.split("|")[0].trim();

  const normalizedTitle =
    normalizeText(title);

  const existing = await env.DB.prepare(
    `SELECT id
     FROM movies
     WHERE title = ?
       AND source_channel = ?
     LIMIT 1`
  )
    .bind(title, source)
    .first();

  if (existing) {
    return;
  }

  await env.DB.prepare(
    `INSERT INTO movies
    (
      title,
      language,
      season,
      quality,
      file_name,
      telegram_file_id,
      terabox_url,
      source_type,
      source_channel,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      normalizedTitle || title,
      null,
      null,
      null,
      fileName,
      fileId,
      extractTeraBox(text),
      extractTeraBox(text) ? "terabox" : sourceType || "telegram",
      source,
      now()
    )
    .run();
}

function extractTeraBox(text = "") {
  const match = text.match(
    /https?:\/\/(?:www\.)?terabox\.com\/\S+/i
  );

  return match ? match[0] : null;
}

async function cleanupExpired(env) {
  const cutoff = now();

  const result = await env.DB.prepare(
    `SELECT key, value
     FROM settings
     WHERE key LIKE 'delete:%'
       AND CAST(value AS INTEGER) <= ?`
  )
    .bind(cutoff)
    .all();

  for (const row of result.results || []) {
    const parts = row.key.split(":");

    if (parts.length >= 3) {
      const chatId = parts[1];
      const messageId = Number(parts.slice(2).join(":"));

      await deleteMessage(
        env,
        chatId,
        messageId
      );
    }

    await env.DB.prepare(
      "DELETE FROM settings WHERE key = ?"
    )
      .bind(row.key)
      .run();
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "GET") {
      return new Response(
        "MovieDeta Bot is running!"
      );
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
      });
    }

    try {
      const update = await request.json();

      await processUpdate(env, update);

      return json({
        ok: true,
      });
    } catch (error) {
      console.error(error);

      return json({
        ok: false,
        error: error.message,
      });
    }
  },

  async scheduled(event, env) {
    await cleanupExpired(env);
  },
};
