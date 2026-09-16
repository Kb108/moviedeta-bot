const TELEGRAM_API = (token) =>
  `https://api.telegram.org/bot${token}`;

const DELETE_AFTER_SECONDS = 300;

function now() {
  return Math.floor(Date.now() / 1000);
}

function normalize(text = "") {
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(text = "") {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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

/* =========================================
   URL HELPERS
========================================= */

function getBotUsername(env) {
  return String(env.BOT_USERNAME || "")
    .replace("@", "")
    .trim();
}

function addToGroupUrl(env) {
  return `https://t.me/${getBotUsername(env)}?startgroup=true`;
}

/* =========================================
   MAIN MENU
========================================= */

function mainInlineKeyboard(env) {
  return {
    inline_keyboard: [
      [
        {
          text: "➕ ADD ME TO GROUP",
          url: addToGroupUrl(env)
        }
      ],
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

/* =========================================
   TELEGRAM MENU BUTTON
========================================= */

async function setupMenuButton(env) {
  const commands = [
    {
      command: "start",
      description: "Start MovieDeta Bot"
    },
    {
      command: "help",
      description: "Get help"
    },
    {
      command: "movies",
      description: "Search movies"
    },
    {
      command: "referral",
      description: "Referral link"
    }
  ];

  await telegram(env, "setMyCommands", {
    commands
  });

  await telegram(env, "setChatMenuButton", {
    menu_button: {
      type: "commands",
      text: "MENU"
    }
  });
}

/* =========================================
   FORCE JOIN
========================================= */

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

    if (!result.ok) return false;

    return [
      "creator",
      "administrator",
      "member"
    ].includes(result.result?.status);

  } catch {
    return false;
  }
}

function joinKeyboard(env) {
  const channel =
    String(env.FORCE_JOIN_CHANNEL || "")
      .replace("@", "")
      .trim();

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

/* =========================================
   USER
========================================= */

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
    Math.random()
      .toString(36)
      .substring(2, 10);

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
      referralCode
    )
    .run();
}

/* =========================================
   TeraBox PARSER
========================================= */

function extractTeraBoxLinks(text = "") {
  const regex =
    /https?:\/\/(?:www\.)?(?:1024)?terabox\.com\/[^\s]+/gi;

  const matches = text.match(regex) || [];

  return [...new Set(matches)];
}

function extractQualityLinks(text = "") {
  const results = [];

  const regex =
    /(?:⭕\s*)?(\d{3,4}p)\s*[:=-]\s*(https?:\/\/(?:www\.)?(?:1024)?terabox\.com\/[^\s]+)/gi;

  let match;

  while ((match = regex.exec(text)) !== null) {
    results.push({
      quality: match[1],
      url: match[2].replace(/[)\],.]+$/, "")
    });
  }

  return results;
}

/* =========================================
   MOVIE INFO PARSER
========================================= */

function parseMovieInfo(text, fallbackFileName = "") {
  const lines = String(text)
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);

  let title = "";
  let language = null;
  let season = "Movie";
  let quality = null;
  let year = null;

  if (lines.length) {
    title = lines[0]
      .replace(/^🎬\s*/i, "")
      .trim();
  }

  const yearMatch =
    title.match(/\((19|20)\d{2}\)/);

  if (yearMatch) {
    year = yearMatch[0]
      .replace(/[()]/g, "");
  }

  for (const line of lines) {

    if (/^language\s*:/i.test(line)) {
      language =
        line.split(":").slice(1).join(":").trim();
    }

    if (/^season\s*:/i.test(line)) {
      season =
        line.split(":").slice(1).join(":").trim();
    }

    if (/^quality\s*:/i.test(line)) {
      quality =
        line.split(":").slice(1).join(":").trim();
    }
  }

  /* Detect language from hashtag/text */

  if (!language) {
    const languageMatch =
      text.match(
        /#([A-Za-z]+)\s+dubbed/i
      );

    if (languageMatch) {
      language =
        languageMatch[1]
          .charAt(0)
          .toUpperCase() +
        languageMatch[1].slice(1);
    }
  }

  /* Detect quality */

  if (!quality) {
    const qualityMatch =
      text.match(
        /\b(480p|720p|1080p|2160p|4k)\b/i
      );

    if (qualityMatch) {
      quality =
        qualityMatch[1];
    }
  }

  if (!title) {
    title =
      fallbackFileName ||
      "Unknown Movie";
  }

  return {
    title,
    language,
    season,
    quality,
    year
  };
}

/* =========================================
   DATABASE SEARCH
========================================= */

async function searchMovies(env, query) {
  const q = normalize(query);

  if (!q) return [];

  const words = q.split(" ");

  let sql = `
    SELECT *
    FROM movies
    WHERE 1 = 1
  `;

  const params = [];

  for (const word of words) {
    sql += `
      AND (
        title LIKE ?
        OR title LIKE ?
      )
    `;

    params.push(`%${word}%`);
    params.push(`%${word}%`);
  }

  sql += `
    ORDER BY created_at DESC
    LIMIT 20
  `;

  const result =
    await env.DB.prepare(sql)
      .bind(...params)
      .all();

  return result.results || [];
}

/* =========================================
   DELETE QUEUE
========================================= */

async function scheduleDelete(
  env,
  chatId,
  messageId
) {
  if (!messageId) return;

  const key =
    `delete:${chatId}:${messageId}`;

  const deleteAt =
    now() + DELETE_AFTER_SECONDS;

  await env.DB.prepare(
    `INSERT OR REPLACE INTO settings
     (key, value)
     VALUES (?, ?)`
  )
    .bind(
      key,
      String(deleteAt)
    )
    .run();
}

async function cleanupMessages(env) {
  const current = now();

  const result =
    await env.DB.prepare(
      `SELECT key
       FROM settings
       WHERE key LIKE 'delete:%'
       AND CAST(value AS INTEGER) <= ?`
    )
      .bind(current)
      .all();

  for (const row of result.results || []) {

    const parts =
      row.key.split(":");

    if (parts.length >= 3) {

      const chatId = parts[1];

      const messageId =
        Number(
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

/* =========================================
   INDEX CHANNEL POST
========================================= */

async function indexChannelPost(env, post) {
  const text =
    post.caption ||
    post.text ||
    "";

  let fileId = null;
  let fileName = null;
  let sourceType = null;

  /* Video */

  if (post.video?.file_id) {
    fileId =
      post.video.file_id;

    fileName =
      post.video.file_name ||
      `video_${post.message_id}.mp4`;

    sourceType =
      "video";
  }

  /* Document */

  if (post.document?.file_id) {
    fileId =
      post.document.file_id;

    fileName =
      post.document.file_name ||
      `document_${post.message_id}`;

    sourceType =
      "telegram";
  }

  /* TeraBox */

  const teraboxLinks =
    extractQualityLinks(text);

  const allTeraBoxLinks =
    teraboxLinks.length
      ? teraboxLinks
      : extractTeraBoxLinks(text).map(url => ({
          quality: null,
          url
        }));

  if (!fileId && !allTeraBoxLinks.length) {
    return;
  }

  if (allTeraBoxLinks.length) {
    sourceType = "terabox";
  }

  const info =
    parseMovieInfo(
      text,
      fileName
    );

  const sourceChannel =
    post.chat?.username
      ? `@${post.chat.username}`
      : String(post.chat?.id || "");

  /* Check existing movie */

  const existing =
    await env.DB.prepare(
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

  /* Store quality links as JSON */

  const linksJson =
    allTeraBoxLinks.length
      ? JSON.stringify(allTeraBoxLinks)
      : null;

  if (existing) {

    await env.DB.prepare(
      `UPDATE movies
       SET language = ?,
           season = ?,
           quality = ?,
           file_name = ?,
           telegram_file_id = ?,
           terabox_url = ?,
           terabox_links = ?,
           source_type = ?
       WHERE id = ?`
    )
      .bind(
        info.language,
        info.season,
        info.quality,
        fileName,
        fileId,
        allTeraBoxLinks[0]?.url || null,
        linksJson,
        sourceType,
        existing.id
      )
      .run();

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
      terabox_links,
      source_type,
      source_channel,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      normalize(info.title),
      info.language,
      info.season,
      info.quality,
      fileName,
      fileId,
      allTeraBoxLinks[0]?.url || null,
      linksJson,
      sourceType,
      sourceChannel,
      now()
    )
    .run();
}

/* =========================================
   MOVIE RESULT BUTTONS
========================================= */

function qualityButtons(movie) {
  let links = [];

  try {
    links =
      JSON.parse(
        movie.terabox_links || "[]"
      );
  } catch {
    links = [];
  }

  if (!links.length && movie.terabox_url) {
    links = [
      {
        quality:
          movie.quality || "OPEN",
        url:
          movie.terabox_url
      }
    ];
  }

  return links.map(item => [
    {
      text:
        `🎬 ${item.quality || "DOWNLOAD"}`,
      callback_data:
        `quality:${movie.id}:${encodeURIComponent(item.url)}`
    }
  ]);
}

/* =========================================
   GROUP SEARCH
========================================= */

async function searchFromGroup(env, message) {
  const query =
    message.text?.trim();

  if (!query) return;

  const results =
    await searchMovies(
      env,
      query
    );

  if (!results.length) {

    const response =
      await sendMessage(
        env,
        message.chat.id,

        `❌ <b>Movie Not Found</b>\n\n` +
        `No movie found for:\n` +
        `<code>${escapeHtml(query)}</code>\n\n` +
        `Please check the spelling and try again.`
      );

    await scheduleDelete(
      env,
      message.chat.id,
      response.result?.message_id
    );

    return;
  }

  const buttons = [];

  /* FIRST BUTTON */

  buttons.push([
    {
      text: "➕ ADD ME TO GROUP",
      url: addToGroupUrl(env)
    }
  ]);

  for (const movie of results) {

    buttons.push([
      {
        text:
          `🎬 ${movie.title}` +
          (
            movie.quality
              ? ` • ${movie.quality}`
              : ""
          ),

        callback_data:
          `movie:${movie.id}`
      }
    ]);
  }

  buttons.push([
    {
      text:
        "🛍️ FLIPKART / AMAZON OFFERS",
      url:
        env.OFFERS_URL
    }
  ]);

  const response =
    await sendMessage(
      env,
      message.chat.id,

      `🔎 <b>Movie Search</b>\n\n` +
      `Results for:\n` +
      `<b>${escapeHtml(query)}</b>\n\n` +
      `Select a movie below:`,

      {
        reply_markup: {
          inline_keyboard:
            buttons
        }
      }
    );

  await scheduleDelete(
    env,
    message.chat.id,
    response.result?.message_id
  );
}

/* =========================================
   SEND MOVIE
========================================= */

async function sendMovie(env, chatId, movie) {

  const text =
    `🎬 <b>${escapeHtml(movie.title)}</b>\n\n` +
    `🌐 Language: <b>${escapeHtml(movie.language || "N/A")}</b>\n` +
    `🎞️ Season: <b>${escapeHtml(movie.season || "Movie")}</b>\n` +
    `🎥 Quality: <b>${escapeHtml(movie.quality || "Multiple")}</b>\n` +
    `📁 File Name: <b>${escapeHtml(movie.file_name || "N/A")}</b>\n\n` +
    `🔗 <b>ALL GROUP LINKS</b>`;

  let qualityBtns =
    qualityButtons(movie);

  const buttons = [
    ...qualityBtns,
    [
      {
        text:
          "👉 CLICK HERE",
        url:
          env.MOVIE_GROUP_URL
      }
    ],
    [
      {
        text:
          "🛍️ FLIPKART / AMAZON OFFERS",
        url:
          env.OFFERS_URL
      }
    ]
  ];

  let response;

  /* TeraBox */

  if (
    movie.source_type === "terabox"
  ) {

    response =
      await sendMessage(
        env,
        chatId,
        text,
        {
          reply_markup: {
            inline_keyboard:
              buttons
          }
        }
      );

  }

  /* Telegram video */

  else if (
    movie.source_type === "video" &&
    movie.telegram_file_id
  ) {

    response =
      await telegram(
        env,
        "sendVideo",
        {
          chat_id:
            chatId,

          video:
            movie.telegram_file_id,

          caption:
            text,

          parse_mode:
            "HTML",

          reply_markup: {
            inline_keyboard:
              buttons
          }
        }
      );

  }

  /* Telegram document */

  else if (
    movie.telegram_file_id
  ) {

    response =
      await telegram(
        env,
        "sendDocument",
        {
          chat_id:
            chatId,

          document:
            movie.telegram_file_id,

          caption:
            text,

          parse_mode:
            "HTML",

          reply_markup: {
            inline_keyboard:
              buttons
          }
        }
      );

  }

  else {

    response =
      await sendMessage(
        env,
        chatId,

        `❌ <b>File Not Available</b>`
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

/* =========================================
   CALLBACK HANDLER
========================================= */

async function handleCallback(env, callback) {

  const data =
    callback.data;

  const userId =
    callback.from.id;

  const chatId =
    callback.message.chat.id;

  await telegram(
    env,
    "answerCallbackQuery",
    {
      callback_query_id:
        callback.id
    }
  );

  /* CHECK JOIN */

  if (data === "check_join") {

    const joined =
      await checkMembership(
        env,
        userId
      );

    if (!joined) {

      await sendMessage(
        env,
        chatId,

        `❌ <b>You have not joined the required channel.</b>\n\n` +
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
          mainInlineKeyboard(env)
      }
    );

    return;
  }

  /* REFERRAL */

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

    const link =
      `https://t.me/${getBotUsername(env)}?start=${user.referral_code}`;

    await sendMessage(
      env,
      chatId,

      `<b>👥 YOUR REFERRAL LINK</b>\n\n` +
      `<code>${escapeHtml(link)}</code>`
    );

    return;
  }

  /* MOVIE */

  if (data.startsWith("movie:")) {

    const movieId =
      Number(
        data.split(":")[1]
      );

    const movie =
      await env.DB.prepare(
        `SELECT *
         FROM movies
         WHERE id = ?`
      )
      .bind(movieId)
      .first();

    if (!movie) {

      await sendMessage(
        env,
        chatId,
        `❌ <b>Movie not found.</b>`
      );

      return;
    }

    const joined =
      await checkMembership(
        env,
        userId
      );

    if (!joined) {

      await sendMessage(
        env,
        chatId,

        `🔒 <b>JOIN REQUIRED</b>\n\n` +
        `Please join the required channel first.`,

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

    return;
  }

  /* QUALITY */

  if (data.startsWith("quality:")) {

    const parts =
      data.split(":");

    const movieId =
      Number(parts[1]);

    const url =
      decodeURIComponent(
        parts.slice(2).join(":")
      );

    const movie =
      await env.DB.prepare(
        `SELECT *
         FROM movies
         WHERE id = ?`
      )
      .bind(movieId)
      .first();

    if (!movie) return;

    const joined =
      await checkMembership(
        env,
        userId
      );

    if (!joined) {

      await sendMessage(
        env,
        chatId,

        `🔒 <b>JOIN REQUIRED</b>`,

        {
          reply_markup:
            joinKeyboard(env)
        }
      );

      return;
    }

    const response =
      await sendMessage(
        env,
        chatId,

        `🎬 <b>${escapeHtml(movie.title)}</b>\n\n` +
        `🔗 <b>Download Link</b>`,

        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text:
                    "🔗 OPEN TERABOX",
                  url
                }
              ],
              [
                {
                  text:
                    "👉 ALL GROUP LINKS",
                  url:
                    env.MOVIE_GROUP_URL
                }
              ]
            ]
          }
        }
      );

    await scheduleDelete(
      env,
      chatId,
      response.result?.message_id
    );
  }
}

/* =========================================
   PRIVATE CHAT
========================================= */

async function handlePrivateMessage(env, message) {

  const chatId =
    message.chat.id;

  const text =
    message.text?.trim() || "";

  if (text.startsWith("/start")) {

    await sendMessage(
      env,
      chatId,

      `<b>🎬 Welcome to MovieDeta Bot!</b>\n\n` +
      `Search movies quickly and access available files or links.\n\n` +
      `This bot is free to use.`,

      {
        reply_markup:
          mainInlineKeyboard(env)
      }
    );

    return;
  }

  if (text === "/help") {

    await sendMessage(
      env,
      chatId,

      `<b>🆘 HELP</b>\n\n` +
      `Search a movie in the supported group.\n` +
      `Select the movie result.\n` +
      `Join the required channel.\n` +
      `Then access the available content.`,

      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text:
                  "🆘 CONTACT SUPPORT",
                url:
                  env.HELP_URL
              }
            ]
          ]
        }
      }
    );

    return;
  }

  if (text === "/movies") {

    await sendMessage(
      env,
      chatId,

      `🎬 <b>Movie Search</b>\n\n` +
      `Search movies from the supported group.`,

      {
        reply_markup:
          mainInlineKeyboard(env)
      }
    );

    return;
  }

  if (text === "/referral") {

    const user =
      await env.DB.prepare(
        `SELECT referral_code
         FROM users
         WHERE user_id = ?`
      )
      .bind(message.from.id)
      .first();

    if (user) {

      const link =
        `https://t.me/${getBotUsername(env)}?start=${user.referral_code}`;

      await sendMessage(
        env,
        chatId,

        `<b>👥 YOUR REFERRAL LINK</b>\n\n` +
        `<code>${escapeHtml(link)}</code>`
      );
    }

    return;
  }
}

/* =========================================
   UPDATE PROCESSOR
========================================= */

async function processUpdate(env, update) {

  /* Callback */

  if (update.callback_query) {
    return handleCallback(
      env,
      update.callback_query
    );
  }

  /* Channel post */

  if (update.channel_post) {

    return indexChannelPost(
      env,
      update.channel_post
    );
  }

  if (!update.message) return;

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

  /* GROUP */

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

  /* PRIVATE */

  if (chatType === "private") {

    return handlePrivateMessage(
      env,
      message
    );
  }
}

/* =========================================
   CLOUDFLARE WORKER
========================================= */

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

      console.error(
        "Worker Error:",
        error
      );

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

    await setupMenuButton(env);
  }
};
