const TELEGRAM_API = (token) =>
  `https://api.telegram.org/bot${token}`;

const DELETE_AFTER_SECONDS = 300;

function currentTime() {
  return Math.floor(Date.now() / 1000);
}

function html(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function normalize(value = "") {
  return String(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function telegram(env, method, data) {
  const response = await fetch(
    `${TELEGRAM_API(env.BOT_TOKEN)}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(data)
    }
  );

  return response.json();
}

async function sendMessage(env, chatId, text, extra = {}) {
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...extra
  });
}

async function deleteMessage(env, chatId, messageId) {
  if (!messageId) return;

  return telegram(env, "deleteMessage", {
    chat_id: chatId,
    message_id: messageId
  });
}

/* -----------------------------
   USER
----------------------------- */

async function saveUser(env, user) {
  if (!user?.id) return;

  const existing = await env.DB.prepare(
    "SELECT user_id FROM users WHERE user_id = ?"
  )
    .bind(user.id)
    .first();

  if (existing) {
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

    return;
  }

  const referralCode =
    Math.random().toString(36).substring(2, 10);

  await env.DB.prepare(
    `INSERT INTO users
     (user_id, username, first_name, joined_at, referral_code)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(
      user.id,
      user.username || null,
      user.first_name || null,
      currentTime(),
      referralCode
    )
    .run();
}

/* -----------------------------
   FORCE JOIN
----------------------------- */

async function checkMembership(env, userId) {
  try {
    const result = await telegram(
      env,
      "getChatMember",
      {
        chat_id: env.FORCE_JOIN_CHANNEL,
        user_id: userId
      }
    );

    if (!result.ok) {
      return false;
    }

    const status = result.result?.status;

    return [
      "creator",
      "administrator",
      "member"
    ].includes(status);
  } catch {
    return false;
  }
}

function joinKeyboard(env) {
  const channel =
    env.FORCE_JOIN_CHANNEL.replace("@", "");

  return {
    inline_keyboard: [
      [
        {
          text: "📢 JOIN CHANNEL",
          url: `https://t.me/${channel}`
        }
      ],
      [
        {
          text: "✅ CHECK JOIN",
          callback_data: "check_join"
        }
      ]
    ]
  };
}

/* -----------------------------
   MAIN MENU
----------------------------- */

function mainKeyboard(env) {
  return {
    inline_keyboard: [
      [
        {
          text: "🎬 MOVIE GROUP",
          url: env.MOVIE_GROUP_URL
        }
      ],
      [
        {
          text: "🛍️ FLIPKART / AMAZON OFFERS",
          url: env.OFFERS_URL
        }
      ],
      [
        {
          text: "🆘 HELP",
          url: env.HELP_URL
        }
      ],
      [
        {
          text: "👥 REFERRAL",
          callback_data: "referral"
        }
      ]
    ]
  };
}

/* -----------------------------
   SEARCH
----------------------------- */

async function searchMovies(env, query) {
  const normalized = normalize(query);

  if (!normalized) {
    return [];
  }

  const words = normalized.split(" ");

  let sql = `
    SELECT *
    FROM movies
    WHERE 1 = 1
  `;

  const params = [];

  for (const word of words) {
    sql += ` AND title LIKE ?`;
    params.push(`%${word}%`);
  }

  sql += `
    ORDER BY created_at DESC
    LIMIT 20
  `;

  const result = await env.DB.prepare(sql)
    .bind(...params)
    .all();

  return result.results || [];
}

async function searchFromGroup(env, message) {
  const query = message.text?.trim();

  if (!query) return;

  const results = await searchMovies(env, query);

  if (!results.length) {
    const response = await sendMessage(
      env,
      message.chat.id,
      `❌ <b>Movie Not Found</b>\n\n` +
      `No movie found for:\n` +
      `<code>${html(query)}</code>\n\n` +
      `Try another spelling or a shorter movie name.`
    );

    await scheduleDelete(
      env,
      message.chat.id,
      response.result?.message_id
    );

    return;
  }

  const buttons = [];

  for (const movie of results) {
    buttons.push([
      {
        text:
          `🎬 ${movie.title}` +
          (movie.quality
            ? ` • ${movie.quality}`
            : ""),
        callback_data: `movie:${movie.id}`
      }
    ]);
  }

  buttons.push([
    {
      text: "🛍️ FLIPKART / AMAZON OFFERS",
      url: env.OFFERS_URL
    }
  ]);

  const response = await sendMessage(
    env,
    message.chat.id,
    `🔎 <b>Movie Search</b>\n\n` +
    `Results for:\n` +
    `<b>${html(query)}</b>\n\n` +
    `Select a movie below:`,
    {
      reply_markup: {
        inline_keyboard: buttons
      }
    }
  );

  await scheduleDelete(
    env,
    message.chat.id,
    response.result?.message_id
  );
}

/* -----------------------------
   MOVIE
----------------------------- */

async function getMovie(env, id) {
  return env.DB.prepare(
    "SELECT * FROM movies WHERE id = ?"
  )
    .bind(id)
    .first();
}

function movieText(movie) {
  return (
    `🎬 <b>${html(movie.title)}</b>\n\n` +
    `🌐 Language: ${html(movie.language || "N/A")}\n` +
    `🎞️ Season: ${html(movie.season || "Movie")}\n` +
    `🎥 Quality: ${html(movie.quality || "N/A")}\n` +
    `📁 File Name: ${html(movie.file_name || "N/A")}`
  );
}

async function sendMovie(env, chatId, movie) {
  const caption =
    movieText(movie) +
    `\n\n🔗 <b>ALL GROUP LINKS</b>`;

  const replyMarkup = {
    inline_keyboard: [
      [
        {
          text: "👉 CLICK HERE",
          url: env.MOVIE_GROUP_URL
        }
      ],
      [
        {
          text: "🛍️ FLIPKART / AMAZON OFFERS",
          url: env.OFFERS_URL
        }
      ]
    ]
  };

  let response;

  if (
    movie.source_type === "terabox" &&
    movie.terabox_url
  ) {
    response = await sendMessage(
      env,
      chatId,
      caption +
        `\n\n🔗 <b>TERABOX LINK</b>`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🔗 OPEN TERABOX",
                url: movie.terabox_url
              }
            ],
            [
              {
                text: "👉 ALL GROUP LINKS",
                url: env.MOVIE_GROUP_URL
              }
            ]
          ]
        }
      }
    );
  } else if (
    movie.source_type === "video" &&
    movie.telegram_file_id
  ) {
    response = await telegram(
      env,
      "sendVideo",
      {
        chat_id: chatId,
        video: movie.telegram_file_id,
        caption,
        parse_mode: "HTML",
        reply_markup: replyMarkup
      }
    );
  } else if (movie.telegram_file_id) {
    response = await telegram(
      env,
      "sendDocument",
      {
        chat_id: chatId,
        document: movie.telegram_file_id,
        caption,
        parse_mode: "HTML",
        reply_markup: replyMarkup
      }
    );
  } else {
    response = await sendMessage(
      env,
      chatId,
      `❌ <b>File Not Available</b>\n\n` +
      `The movie was found, but no file/link is available.`
    );
  }

  if (
    response?.ok &&
    response.result?.message_id
  ) {
    await scheduleDelete(
      env,
      chatId,
      response.result.message_id
    );
  }

  return response;
}

/* -----------------------------
   DELETE QUEUE
----------------------------- */

async function scheduleDelete(
  env,
  chatId,
  messageId
) {
  if (!messageId) return;

  const key =
    `delete:${chatId}:${messageId}`;

  const deleteAt =
    currentTime() + DELETE_AFTER_SECONDS;

  await env.DB.prepare(
    `INSERT OR REPLACE INTO settings
     (key, value)
     VALUES (?, ?)`
  )
    .bind(key, String(deleteAt))
    .run();
}

async function cleanupMessages(env) {
  const current = currentTime();

  const result = await env.DB.prepare(
    `SELECT key
     FROM settings
     WHERE key LIKE 'delete:%'
     AND CAST(value AS INTEGER) <= ?`
  )
    .bind(current)
    .all();

  for (const row of result.results || []) {
    const parts = row.key.split(":");

    if (parts.length >= 3) {
      const chatId = parts[1];
      const messageId = Number(
        parts.slice(2).join(":")
      );

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

/* -----------------------------
   CHANNEL INDEXING
----------------------------- */

function extractTeraBox(text = "") {
  const match = text.match(
    /https?:\/\/(?:www\.)?terabox\.com\/[^\s]+/i
  );

  return match ? match[0] : null;
}

function parseMovieInfo(text, fallbackFileName) {
  const lines = text
    .split("\n")
    .map(x => x.trim())
    .filter(Boolean);

  let title = "";
  let language = null;
  let season = null;
  let quality = null;

  if (lines.length) {
    title = lines[0]
      .replace(/^🎬\s*/i, "")
      .trim();
  }

  for (const line of lines) {
    if (/language\s*:/i.test(line)) {
      language =
        line.split(":").slice(1).join(":").trim();
    }

    if (/season\s*:/i.test(line)) {
      season =
        line.split(":").slice(1).join(":").trim();
    }

    if (/quality\s*:/i.test(line)) {
      quality =
        line.split(":").slice(1).join(":").trim();
    }
  }

  if (!title) {
    title = fallbackFileName || "Unknown Movie";
  }

  return {
    title,
    language,
    season,
    quality
  };
}

async function indexChannelPost(env, post) {
  const text =
    post.caption ||
    post.text ||
    "";

  let fileId = null;
  let fileName = null;
  let sourceType = null;

  if (post.video?.file_id) {
    fileId = post.video.file_id;
    fileName =
      post.video.file_name ||
      `video_${post.message_id}.mp4`;
    sourceType = "video";
  }

  if (post.document?.file_id) {
    fileId = post.document.file_id;
    fileName =
      post.document.file_name ||
      `document_${post.message_id}`;
    sourceType = "telegram";
  }

  const teraboxUrl =
    extractTeraBox(text);

  if (!fileId && !teraboxUrl) {
    return;
  }

  if (teraboxUrl) {
    sourceType = "terabox";
  }

  const info = parseMovieInfo(
    text,
    fileName
  );

  const sourceChannel =
    post.chat.username
      ? `@${post.chat.username}`
      : String(post.chat.id);

  const duplicate = await env.DB.prepare(
    `SELECT id
     FROM movies
     WHERE title = ?
     AND source_channel = ?
     LIMIT 1`
  )
    .bind(
      normalize(info.title),
      sourceChannel
    )
    .first();

  if (duplicate) {
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
      normalize(info.title),
      info.language,
      info.season,
      info.quality,
      fileName,
      fileId,
      teraboxUrl,
      sourceType,
      sourceChannel,
      currentTime()
    )
    .run();
}

/* -----------------------------
   CALLBACKS
----------------------------- */

async function handleCallback(env, callback) {
  const data = callback.data;
  const userId = callback.from.id;
  const chatId = callback.message.chat.id;

  await telegram(
    env,
    "answerCallbackQuery",
    {
      callback_query_id: callback.id
    }
  );

  if (data === "check_join") {
    const joined =
      await checkMembership(env, userId);

    if (!joined) {
      await sendMessage(
        env,
        chatId,
        `❌ <b>You have not joined the channel.</b>\n\n` +
        `Join the channel and press CHECK JOIN again.`,
        {
          reply_markup:
            joinKeyboard(env)
        }
      );

      return;
    }

    await sendMessage(
      env,
      chatId,
      `✅ <b>Verification Successful</b>\n\n` +
      `You can now access the movie.`,
      {
        reply_markup:
          mainKeyboard(env)
      }
    );

    return;
  }

  if (data === "about") {
    await sendMessage(
      env,
      chatId,
      `<b>🎬 MOVIEDETA BOT</b>\n\n` +
      `🔎 Movie Search\n` +
      `📺 Telegram File Support\n` +
      `🔗 TeraBox Support\n` +
      `🔐 Channel Verification\n` +
      `🧹 Automatic Message Cleanup\n\n` +
      `<b>Free to use.</b>`
    );

    return;
  }

  if (data === "referral") {
    const user =
      await env.DB.prepare(
        `SELECT referral_code
         FROM users
         WHERE user_id = ?`
      )
      .bind(userId)
      .first();

    if (!user) return;

    const referralLink =
      `https://t.me/${env.BOT_USERNAME}?start=${user.referral_code}`;

    await sendMessage(
      env,
      chatId,
      `<b>👥 YOUR REFERRAL LINK</b>\n\n` +
      `<code>${html(referralLink)}</code>`
    );

    return;
  }

  if (data.startsWith("movie:")) {
    const movieId =
      Number(data.split(":")[1]);

    const movie =
      await getMovie(env, movieId);

    if (!movie) {
      await sendMessage(
        env,
        chatId,
        `❌ <b>Movie not found.</b>`
      );

      return;
    }

    const joined =
      await checkMembership(env, userId);

    if (!joined) {
      await sendMessage(
        env,
        chatId,
        `🔒 <b>JOIN REQUIRED</b>\n\n` +
        `Please join our channel before accessing this movie.`,
        {
          reply_markup:
            joinKeyboard(env)
        }
      );

      return;
    }

    await sendMovie(
      env,
      chatId,
      movie
    );
  }
}

/* -----------------------------
   COMMANDS
----------------------------- */

async function handlePrivateMessage(
  env,
  message
) {
  const text =
    message.text?.trim() || "";

  const chatId =
    message.chat.id;

  if (text.startsWith("/start")) {
    await sendMessage(
      env,
      chatId,
      `<b>🎬 Welcome to MovieDeta Bot!</b>\n\n` +
      `Search movies quickly and easily.\n\n` +
      `Use this bot for free.`,
      {
        reply_markup:
          mainKeyboard(env)
      }
    );

    return;
  }

  if (text === "/help") {
    await sendMessage(
      env,
      chatId,
      `<b>🆘 HELP</b>\n\n` +
      `Search for a movie from the group.\n` +
      `Select the movie result.\n` +
      `Join the required channel.\n` +
      `Then access the available content.`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🆘 CONTACT SUPPORT",
                url: env.HELP_URL
              }
            ]
          ]
        }
      }
    );

    return;
  }
}

/* -----------------------------
   UPDATE HANDLER
----------------------------- */

async function processUpdate(env, update) {
  if (update.callback_query) {
    return handleCallback(
      env,
      update.callback_query
    );
  }

  if (update.channel_post) {
    return indexChannelPost(
      env,
      update.channel_post
    );
  }

  if (!update.message) {
    return;
  }

  const message =
    update.message;

  if (message.from) {
    await saveUser(
      env,
      message.from
    );
  }

  const chatType =
    message.chat?.type;

  if (
    chatType === "group" ||
    chatType === "supergroup"
  ) {
    if (
      message.text &&
      !message.text.startsWith("/")
    ) {
      return searchFromGroup(
        env,
        message
      );
    }

    return;
  }

  if (chatType === "private") {
    return handlePrivateMessage(
      env,
      message
    );
  }
}

/* -----------------------------
   WORKER
----------------------------- */

export default {
  async fetch(request, env) {
    if (request.method === "GET") {
      return new Response(
        "MovieDeta Bot is running!"
      );
    }

    if (request.method !== "POST") {
      return new Response(
        "Method Not Allowed",
        {
          status: 405
        }
      );
    }

    try {
      const update =
        await request.json();

      await processUpdate(
        env,
        update
      );

      return Response.json({
        ok: true
      });
    } catch (error) {
      console.error(error);

      return Response.json(
        {
          ok: false,
          error: error.message
        },
        {
          status: 500
        }
      );
    }
  },

  async scheduled(event, env) {
    await cleanupMessages(env);
  }
};
