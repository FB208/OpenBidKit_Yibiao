const fs = require('node:fs');
const path = require('node:path');
const { getConfigFilePath } = require('../utils/paths.cjs');

const defaultConfig = {
  api_key: '',
  base_url: '',
  model_name: 'gpt-3.5-turbo',
  image_model: {
    provider: 'volcengine',
    base_url: 'https://ark.cn-beijing.volces.com/api/v3',
    api_key: '',
    model_name: '',
  },
  file_parser: {
    provider: 'local',
    mineru_token: '',
  },
  developer_mode: false,
};

function normalizeConfig(config) {
  return {
    ...defaultConfig,
    ...config,
    image_model: {
      ...defaultConfig.image_model,
      ...(config && config.image_model ? config.image_model : {}),
    },
    file_parser: {
      ...defaultConfig.file_parser,
      ...(config && config.file_parser ? config.file_parser : {}),
    },
  };
}

function createConfigStore(app) {
  const configFile = getConfigFilePath(app);

  return {
    getConfigFilePath() {
      return configFile;
    },

    load() {
      if (!fs.existsSync(configFile)) {
        return normalizeConfig();
      }

      try {
        const raw = fs.readFileSync(configFile, 'utf-8');
        return normalizeConfig(JSON.parse(raw));
      } catch (error) {
        throw new Error(`配置文件读取失败：${error.message}`);
      }
    },

    save(config) {
      try {
        fs.mkdirSync(path.dirname(configFile), { recursive: true });
        fs.writeFileSync(configFile, JSON.stringify(normalizeConfig(config), null, 2), 'utf-8');
        return { success: true, message: '配置已保存', config_path: configFile };
      } catch (error) {
        throw new Error(`配置文件保存失败：${error.message}`);
      }
    },
  };
}

module.exports = {
  createConfigStore,
};
