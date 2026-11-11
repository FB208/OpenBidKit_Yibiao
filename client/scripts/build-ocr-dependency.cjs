// 制作文字识别依赖包（依赖 ID：ocr-v1），生成的 zip 上传到 R2 的 dependencies/ 目录后在看板“依赖管理”登记。
// 运行：node scripts/build-ocr-dependency.cjs --source <素材目录> --version 1.0.0 [--out <zip 路径>]
//
// 素材目录需要自行准备，结构如下：
//   ort/ort.wasm.bundle.min.mjs、ort/ort-wasm-simd-threaded.wasm   取自 npm 包 onnxruntime-web 的 dist（MIT）
//   det/inference.onnx、det/inference.yml                           PaddlePaddle/PP-OCRv5_mobile_det_onnx
//   rec/inference.onnx、rec/inference.yml                           PaddlePaddle/PP-OCRv5_mobile_rec_onnx
//   cls/inference.onnx、cls/inference.yml                           PaddlePaddle/PP-LCNet_x0_25_textline_ori_onnx
//   licenses/                                                       上述运行库和模型的许可证文本，原样放进包里
// 三个模型来自 Hugging Face 上 PaddlePaddle 官方仓库（Apache-2.0）。
//
// 包内 manifest.json 的 format 与客户端 ocrEngine.ts 的 SUPPORTED_MANIFEST_FORMAT 对应；
// 格式变化到旧客户端无法使用时，改用新的依赖 ID（ocr-v2）发布，不要覆盖 ocr-v1。
const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');
const yaml = require('js-yaml');

const MANIFEST_FORMAT = 1;
/** 检测输入的最长边上限：越大越能认出小字，耗时也越长。 */
const DETECTION_MAX_SIDE_LENGTH = 1600;

function readArgs() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 2) {
    args[argv[index].replace(/^--/, '')] = argv[index + 1];
  }
  return args;
}

function readYaml(filePath) {
  return yaml.load(fs.readFileSync(filePath, 'utf-8'));
}

function findTransform(config, name) {
  const entry = (config.PreProcess?.transform_ops || []).find((item) => item && Object.hasOwn(item, name));
  if (!entry) throw new Error(`模型配置里没有 ${name}`);
  return entry[name];
}

function main() {
  const args = readArgs();
  if (!args.source || !args.version) {
    throw new Error('用法：node scripts/build-ocr-dependency.cjs --source <素材目录> --version <版本> [--out <zip 路径>]');
  }
  const source = path.resolve(args.source);
  const outPath = path.resolve(args.out || path.join(__dirname, '..', 'release', 'dependencies', `ocr-v1-${args.version}.zip`));
  const file = (...parts) => {
    const filePath = path.join(source, ...parts);
    if (!fs.existsSync(filePath)) throw new Error(`缺少文件：${filePath}`);
    return filePath;
  };

  const detConfig = readYaml(file('det', 'inference.yml'));
  const recConfig = readYaml(file('rec', 'inference.yml'));
  const clsConfig = readYaml(file('cls', 'inference.yml'));
  const detNormalize = findTransform(detConfig, 'NormalizeImage');
  const clsNormalize = findTransform(clsConfig, 'NormalizeImage');
  const [clsWidth, clsHeight] = findTransform(clsConfig, 'ResizeImage').size;
  const [, recHeight] = findTransform(recConfig, 'RecResizeImg').image_shape;
  const dictionary = recConfig.PostProcess.character_dict.map((item) => String(item));
  if (dictionary.some((item) => item.includes('\n'))) throw new Error('识别字典里有换行符，无法按行保存');

  const manifest = {
    format: MANIFEST_FORMAT,
    version: args.version,
    runtime: { script: 'ort/ort.wasm.bundle.min.mjs', wasm: 'ort/ort-wasm-simd-threaded.wasm' },
    detection: {
      model: 'det.onnx',
      mean: detNormalize.mean,
      std: detNormalize.std,
      thresh: detConfig.PostProcess.thresh,
      boxThresh: detConfig.PostProcess.box_thresh,
      unclipRatio: detConfig.PostProcess.unclip_ratio,
      maxSideLength: DETECTION_MAX_SIDE_LENGTH,
    },
    orientation: { model: 'cls.onnx', width: clsWidth, height: clsHeight, mean: clsNormalize.mean, std: clsNormalize.std },
    recognition: { model: 'rec.onnx', height: recHeight, dictionary: 'dict.txt' },
    models: {
      detection: detConfig.Global.model_name,
      recognition: recConfig.Global.model_name,
      orientation: clsConfig.Global.model_name,
    },
  };

  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'));
  // 字典每行一个字符，末尾不加换行：行号与模型输出的类别一一对应。
  zip.addFile('dict.txt', Buffer.from(dictionary.join('\n'), 'utf-8'));
  zip.addLocalFile(file('ort', 'ort.wasm.bundle.min.mjs'), 'ort');
  zip.addLocalFile(file('ort', 'ort-wasm-simd-threaded.wasm'), 'ort');
  zip.addLocalFile(file('det', 'inference.onnx'), '', 'det.onnx');
  zip.addLocalFile(file('rec', 'inference.onnx'), '', 'rec.onnx');
  zip.addLocalFile(file('cls', 'inference.onnx'), '', 'cls.onnx');
  const licenseNames = fs.readdirSync(file('licenses'));
  if (!licenseNames.length) throw new Error('licenses 目录为空，请放入运行库和模型的许可证文本');
  for (const name of licenseNames) zip.addLocalFile(path.join(source, 'licenses', name), 'licenses');

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  zip.writeZip(outPath);
  console.log(`已生成 ${outPath}`);
  console.log(`大小 ${(fs.statSync(outPath).size / 1024 / 1024).toFixed(1)} MB，字典 ${dictionary.length} 个字符`);
  console.log(JSON.stringify(manifest, null, 2));
}

main();
