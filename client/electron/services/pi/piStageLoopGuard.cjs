// 阶段续接的空转判定：程序连续以相同阶段和相同提示续接、期间没有用户回答，说明同一指令反复重发仍未被执行。
// 只负责判定；判定后的诊断和处理由 piStallDiagnosis 统一完成，业务阶段不再自行计数。
const STAGE_LOOP_LIMIT = 3;

function createStageLoopGuard(limit = STAGE_LOOP_LIMIT) {
  let lastKey = null;
  let repeats = 0;

  return {
    inspect({ stage, prompt, userAnswered }) {
      const key = `${stage}\n${prompt}`;
      repeats = key === lastKey && !userAnswered ? repeats + 1 : 0;
      lastKey = key;
      return { stalled: repeats >= limit, repeats };
    },
    // 诊断说明发出后重新计数：保留上一条续接，之后相同的续接从 1 开始累计。
    restart() {
      repeats = 0;
    },
  };
}

module.exports = { STAGE_LOOP_LIMIT, createStageLoopGuard };
