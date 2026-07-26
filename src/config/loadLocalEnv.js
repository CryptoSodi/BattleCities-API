const fs = require('fs');
const path = require('path');

function loadLocalEnv(filePath) {
  const candidates =
    typeof filePath === 'string'
      ? [filePath]
      : [
          path.join(process.cwd(), '.env.local'),
          path.resolve(process.cwd(), '..', '.env.local'),
        ];

  candidates.forEach(loadEnvFile);
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      return;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) {
      return;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  });
}

module.exports = {
  loadLocalEnv,
};
