/**
 * Configuration module for the WhatsApp Auto-Reply Bot.
 * Loads settings from environment variables with sensible defaults.
 */

require('dotenv').config();

function getEnv(key, defaultValue) {
  const value = process.env[key];
  if (value === undefined || value === '') {
    return defaultValue;
  }
  return value;
}

function getEnvInt(key, defaultValue) {
  const value = parseInt(getEnv(key, String(defaultValue)), 10);
  return Number.isNaN(value) ? defaultValue : value;
}

function getEnvFloat(key, defaultValue) {
  const value = parseFloat(getEnv(key, String(defaultValue)));
  return Number.isNaN(value) ? defaultValue : value;
}

function getEnvBool(key, defaultValue) {
  const value = getEnv(key, String(defaultValue));
  return value.toLowerCase() === 'true';
}

const config = {
  userName: getEnv('USER_NAME', 'the user'),
  openaiApiKey: getEnv('OPENAI_API_KEY', ''),
  openaiModel: getEnv('OPENAI_MODEL', 'gpt-4o-mini'),
  maxTokens: getEnvInt('MAX_TOKENS', 300),
  temperature: getEnvFloat('TEMPERATURE', 0.7),
  maxContextMessages: getEnvInt('MAX_CONTEXT_MESSAGES', 20),
  replyToAll: getEnvBool('REPLY_TO_ALL', false),
};

// Validate required settings on load
if (!config.openaiApiKey || config.openaiApiKey === 'sk-your-openai-api-key-here') {
  console.error('ERROR: OPENAI_API_KEY is not set or is still the placeholder value.');
  console.error('Please set the OPENAI_API_KEY environment variable.');
  process.exit(1);
}

if (!config.userName || config.userName === 'the user') {
  console.warn('WARNING: USER_NAME is not set. The bot will use a generic greeting.');
}

module.exports = config;
