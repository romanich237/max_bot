const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_PORT = 3847;

function getPortalPort() {
  const fromEnv = Number(process.env.SETUP_PORT || process.env.SITE_PORT);
  if (fromEnv > 0) return fromEnv;

  const configPath = path.join(__dirname, '..', 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return Number(cfg.sitePortal?.port || cfg.setupPortal?.port || DEFAULT_PORT);
    } catch {
      /* ignore */
    }
  }

  return DEFAULT_PORT;
}

function commandExists(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore', shell: true });
    return true;
  } catch {
    return false;
  }
}

function runQuiet(cmd) {
  execSync(cmd, { stdio: 'pipe', shell: true });
}

function runAsRoot(cmd) {
  try {
    runQuiet(cmd);
    return true;
  } catch {
    try {
      runQuiet(`sudo -n ${cmd}`);
      return true;
    } catch {
      try {
        runQuiet(`sudo ${cmd}`);
        return true;
      } catch {
        return false;
      }
    }
  }
}

function isUfwActive() {
  try {
    const status = execSync('ufw status', { encoding: 'utf8', shell: true });
    return /Status:\s*active/i.test(status);
  } catch {
    return false;
  }
}

function openPortalPort(port = getPortalPort()) {
  if (process.platform !== 'linux') {
    return { ok: false, port, method: null, message: 'Автооткрытие порта доступно только на Linux' };
  }

  const methods = [];

  if (commandExists('ufw') && isUfwActive()) {
    if (runAsRoot(`ufw allow ${port}/tcp`)) {
      methods.push('ufw');
    }
  }

  if (commandExists('firewall-cmd')) {
    if (
      runAsRoot(`firewall-cmd --permanent --add-port=${port}/tcp`) &&
      runAsRoot('firewall-cmd --reload')
    ) {
      methods.push('firewalld');
    }
  }

  if (!methods.length && commandExists('iptables')) {
    if (runAsRoot(`iptables -I INPUT -p tcp --dport ${port} -j ACCEPT`)) {
      methods.push('iptables');
    }
  }

  if (methods.length) {
    const message = `Порт ${port}/tcp открыт (${methods.join(', ')})`;
    console.log(message);
    return { ok: true, port, method: methods.join(', '), message };
  }

  return {
    ok: false,
    port,
    method: null,
    message: `Порт ${port}/tcp: не удалось открыть автоматически (нужен sudo или ufw/firewalld)`,
  };
}

module.exports = {
  DEFAULT_PORT,
  getPortalPort,
  openPortalPort,
};
