import * as Dialog from '@radix-ui/react-dialog';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { AgentQuestion } from '../types';
import MarkdownRenderer from './MarkdownRenderer';
import { useToast } from './ToastProvider';

interface AgentAutoAnswerContextValue {
  enabled: boolean;
  saving: boolean;
  setEnabled: (enabled: boolean) => Promise<void>;
}

const AgentAutoAnswerContext = createContext<AgentAutoAnswerContextValue | null>(null);

// 读取并修改全局共用的 Agent 自动回答设置。
export function useAgentAutoAnswer() {
  const context = useContext(AgentAutoAnswerContext);
  if (!context) throw new Error('useAgentAutoAnswer 必须在 AgentQuestionDialogProvider 内使用');
  return context;
}

// 全局承接 Agent 的待确认问题，并将用户回答返回 Main 进程。
export function AgentQuestionDialogProvider({ children }: { children: ReactNode }) {
  const [question, setQuestion] = useState<AgentQuestion | null>(null);
  const [selectedOptionId, setSelectedOptionId] = useState('');
  const [customAnswer, setCustomAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [autoAnswerEnabled, setAutoAnswerEnabledState] = useState(false);
  const [autoAnswerSaving, setAutoAnswerSaving] = useState(false);
  const [countdownSeconds, setCountdownSeconds] = useState(0);
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
    let active = true;
    let receivedEvent = false;
    const unsubscribe = window.yibiao.agent.onAutoAnswerChanged((state) => {
      receivedEvent = true;
      if (active) setAutoAnswerEnabledState(state.enabled);
    });
    void window.yibiao.agent.getAutoAnswerState()
      .then((state) => {
        if (active && !receivedEvent) setAutoAnswerEnabledState(state.enabled);
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

  const recommendedOption = question?.options.find((option) => option.recommended && !option.custom);

  useEffect(() => {
    if (question?.auto_answer_at && recommendedOption && !selectedOptionId) {
      setSelectedOptionId(recommendedOption.id);
    }
  }, [question?.auto_answer_at, recommendedOption, selectedOptionId]);

  useEffect(() => {
    if (!question?.auto_answer_at) {
      setCountdownSeconds(0);
      return;
    }
    const deadline = new Date(question.auto_answer_at).getTime();
    const updateCountdown = () => {
      setCountdownSeconds(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    };
    updateCountdown();
    const timer = window.setInterval(updateCountdown, 250);
    return () => window.clearInterval(timer);
  }, [question?.auto_answer_at]);

  // 两处开关共用 Main 侧配置，修改后立即持久化。
  const setAutoAnswerEnabled = async (enabled: boolean) => {
    if (autoAnswerSaving) return;
    setAutoAnswerSaving(true);
    try {
      const result = await window.yibiao.agent.setAutoAnswerEnabled(enabled);
      setAutoAnswerEnabledState(result.enabled);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '自动回答设置保存失败', 'error');
    } finally {
      setAutoAnswerSaving(false);
    }
  };

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
    <AgentAutoAnswerContext.Provider value={{
      enabled: autoAnswerEnabled,
      saving: autoAnswerSaving,
      setEnabled: setAutoAnswerEnabled,
    }}>
      {children}
      <Dialog.Root open={Boolean(question)}>
        <Dialog.Portal>
          <Dialog.Overlay className="agent-question-modal" />
          <Dialog.Content
            className="agent-question-card"
            aria-describedby={undefined}
            onEscapeKeyDown={(event) => event.preventDefault()}
            onPointerDownOutside={(event) => event.preventDefault()}
            onInteractOutside={(event) => event.preventDefault()}
          >
            <header className="agent-question-head">
              <Dialog.Title>需要您确认以下问题</Dialog.Title>
            </header>

            <div className="agent-question-body">
              <div className="agent-question-copy">
                <MarkdownRenderer allowRawHtml={false} linkMode="text">{question?.question || ''}</MarkdownRenderer>
              </div>

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
                  placeholder="请输入具体要求"
                  aria-label={`${selectedOption.label}的具体要求`}
                  autoFocus
                  onChange={(event) => setCustomAnswer(event.target.value)}
                />
              )}
            </div>

            <footer className="agent-question-actions">
              <div className="agent-question-auto-answer">
                <label>
                  <span className="yb-switch-control">
                    <input
                      type="checkbox"
                      checked={autoAnswerEnabled}
                      disabled={autoAnswerSaving || submitting}
                      onChange={(event) => void setAutoAnswerEnabled(event.target.checked)}
                    />
                    <span className="yb-switch-track" aria-hidden="true">
                      <span className="yb-switch-thumb" />
                    </span>
                  </span>
                  <span>自动回答</span>
                </label>
                {question?.auto_answer_at && recommendedOption && (
                  <small>{countdownSeconds} 秒后自动执行“{recommendedOption.label}”</small>
                )}
              </div>
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
    </AgentAutoAnswerContext.Provider>
  );
}

export default AgentQuestionDialogProvider;
