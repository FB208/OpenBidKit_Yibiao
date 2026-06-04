import type { DocumentFormatConfig, FileParserConfig, ImageModelConfig, ImageModelProfiles, TextModelConfig, TextModelProfiles, TextModelProvider } from '../../shared/types';

export interface SettingsPageState {
  textModel: TextModelConfig & {
    provider: TextModelProvider;
  };
  textModelProfiles: TextModelProfiles;
  imageModel: ImageModelConfig;
  imageModelProfiles: ImageModelProfiles;
  fileParser: FileParserConfig;
  general: {
    developer_mode: boolean;
  };
  documentFormat: DocumentFormatConfig;
}
