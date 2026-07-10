import type { AgentModeScenariosConfig, ConfiguredTextModelProvider, FileParserConfig, ImageModelConfig, ImageModelProfiles, TextModelConfig, TextModelProfiles, UpdateChannel } from '../../shared/types';

export interface SettingsPageState {
  textModel: Omit<TextModelConfig, 'context_length_limit' | 'concurrency_limit'> & {
    context_length_limit: number | '';
    concurrency_limit: number | '';
    provider: ConfiguredTextModelProvider;
  };
  textModelProfiles: TextModelProfiles;
  imageModel: Omit<ImageModelConfig, 'concurrency_limit'> & {
    concurrency_limit: number | '';
  };
  imageModelProfiles: ImageModelProfiles;
  fileParser: FileParserConfig;
  agentModeScenarios: AgentModeScenariosConfig;
  general: {
    developer_mode: boolean;
    developer_token_stats_auto_open: boolean;
    update_channel: UpdateChannel;
    gpu_hardware_acceleration_enabled: boolean;
    gpu_hardware_acceleration_configured: boolean;
  };
}
