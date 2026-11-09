// 阶段续接的空转保险：程序连续以相同阶段和相同提示续接、期间没有用户回答，说明同一指令反复重发仍未被执行。
// 只负责判定停止；需要更早由程序收尾的业务阶段自行计数处理。
const STAGE_LOOP_LIMIT = 5;

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
  };
}

module.exports = { STAGE_LOOP_LIMIT, createStageLoopGuard };
