import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState, type ReactNode } from 'react';
import type { AgentQuestion } from '../types';
import { useToast } from './ToastProvider';

// 全局承接 Agent 的待确认问题，并将用户回答返回 Main 进程。
export function AgentQuestionDialogProvider({ children }: { children: ReactNode }) {
  const [question, setQuestion] = useState<AgentQuestion | null>(null);
  const [selectedOptionId, setSelectedOptionId] = useState('');
  const [customAnswer, setCustomAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { showToast } = useToast();

  useEffect(() => {
    let active = true;
    let receivedEvent = false;
    const unsubscribe = window.yibiao.agent.onQuestion((nextQuestion) => {
      receivedEvent = true;
      if (active) setQuestion(nextQuestion);
    });
    void window.yibiao.agent.getPendingQuestion()
      .then((pendingQuestion) => {
        if (active && !receivedEvent) setQuestion(pendingQuestion);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    setSelectedOptionId('');
    setCustomAnswer('');
    setSubmitting(false);
  }, [question?.question_id]);

  const selectedOption = question?.options.find((option) => option.id === selectedOptionId);
  const canSubmit = Boolean(
    question
    && selectedOption
    && (!selectedOption.custom || customAnswer.trim()),
  );

  const submitAnswer = async () => {
    if (!question || !selectedOption || !canSubmit || submitting) return;
    const questionId = question.question_id;
    setSubmitting(true);
    try {
      await window.yibiao.agent.answerQuestion({
        question_id: questionId,
        option_id: selectedOption.id,
        custom_answer: selectedOption.custom ? customAnswer.trim() : undefined,
      });
      setQuestion((current) => current?.question_id === questionId ? null : current);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '提交回答失败，请重试', 'error');
      setSubmitting(false);
    }
  };

  return (
    <>
      {children}
      <Dialog.Root open={Boolean(question)}>
        <Dialog.Portal>
          <Dialog.Overlay className="agent-question-modal" />
          <Dialog.Content
            className="agent-question-card"
            onEscapeKeyDown={(event) => event.preventDefault()}
            onPointerDownOutside={(event) => event.preventDefault()}
            onInteractOutside={(event) => event.preventDefault()}
          >
            <header className="agent-question-head">
              <span>AGENT 需要确认</span>
              <Dialog.Title>请选择后继续执行</Dialog.Title>
              <Dialog.Description>
                {question?.task_title || '易标智能体任务'}正在等待您的回答。
              </Dialog.Description>
            </header>

            <div className="agent-question-body">
              <div className="agent-question-copy">{question?.question}</div>

              <div className="agent-question-options" role="radiogroup" aria-label="Agent 提供的选项">
                {question?.options.map((option) => (
                  <label
                    key={option.id}
                    className={`agent-question-option${selectedOptionId === option.id ? ' is-selected' : ''}`}
                  >
                    <input
                      type="radio"
                      name="agent-question-option"
                      value={option.id}
                      checked={selectedOptionId === option.id}
                      disabled={submitting}
                      onChange={() => setSelectedOptionId(option.id)}
                    />
                    <span className="agent-question-radio" aria-hidden="true" />
                    <span className="agent-question-option-copy">
                      <strong>
                        {option.label}
                        {option.recommended && <em>推荐</em>}
                      </strong>
                      {option.description && <small>{option.description}</small>}
                    </span>
                  </label>
                ))}
              </div>

              {selectedOption?.custom && (
                <textarea
                  className="agent-question-custom-answer"
                  value={customAnswer}
                  disabled={submitting}
                  placeholder="请输入您的答案"
                  aria-label="其他答案"
                  autoFocus
                  onChange={(event) => setCustomAnswer(event.target.value)}
                />
              )}
            </div>

            <footer className="agent-question-actions">
              <span>提交后 Agent 将根据您的回答继续执行</span>
              <button
                type="button"
                className="primary-action"
                disabled={!canSubmit || submitting}
                onClick={() => void submitAnswer()}
              >
                {submitting ? '正在提交...' : '确定并继续'}
              </button>
            </footer>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

export default AgentQuestionDialogProvider;
