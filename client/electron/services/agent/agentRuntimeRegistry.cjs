const runtimeDefinitions = [
  {
    id: 'opencode',
    displayName: 'OpenCode Agent',
    description: '使用现有常驻 OpenCode Server 智能体链路。',
    isDefault: true,
    createRuntime(options) {
      const { createOpenCodeRuntimeService } = require('../opencode/opencodeRuntimeService.cjs');
      return createOpenCodeRuntimeService(options);
    },
  },
  {
    id: 'pi',
    displayName: 'Pi Agent',
    description: '使用内嵌 Pi SDK 智能体链路。',
    isDefault: false,
    createRuntime(options) {
      const { createPiRuntimeService } = require('../pi/piRuntimeService.cjs');
      return createPiRuntimeService(options);
    },
  },
];

const runtimeById = new Map(runtimeDefinitions.map((item) => [item.id, item]));
const defaultRuntime = runtimeDefinitions.find((item) => item.isDefault);

if (!defaultRuntime) {
  throw new Error('智能体运行时注册表缺少默认项');
}

// 返回可安全发送给 Renderer 的运行时元数据。
function listAgentRuntimeDescriptors() {
  return runtimeDefinitions.map(({ id, displayName, description, isDefault }) => ({
    id,
    display_name: displayName,
    description,
    is_default: isDefault,
  }));
}

function getDefaultAgentRuntimeId() {
  return defaultRuntime.id;
}

// 空配置应用统一默认值，未知配置直接报错。
function normalizeAgentRuntimeId(value) {
  const runtimeId = String(value || '').trim() || getDefaultAgentRuntimeId();
  if (!runtimeById.has(runtimeId)) {
    throw new Error(`未知的智能体运行时：${runtimeId}`);
  }
  return runtimeId;
}

function getAgentRuntimeDefinition(runtimeId) {
  const normalizedId = normalizeAgentRuntimeId(runtimeId);
  return runtimeById.get(normalizedId);
}

function createAgentRuntime(runtimeId, options) {
  const definition = getAgentRuntimeDefinition(runtimeId);
  return definition.createRuntime({
    ...options,
    runtime: {
      id: definition.id,
      displayName: definition.displayName,
      description: definition.description,
    },
  });
}

module.exports = {
  createAgentRuntime,
  getAgentRuntimeDefinition,
  getDefaultAgentRuntimeId,
  listAgentRuntimeDescriptors,
  normalizeAgentRuntimeId,
};
