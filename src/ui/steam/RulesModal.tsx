import { useState } from 'preact/hooks';
import { ModalShell } from './ModalShell';

const RULES = [
  'I will only accept trade offers created through DMarket. I will double-check that each offer matches the trade details shown on DMarket.',
  'I understand that my browser with the extension needs to be periodically online while I have active trades, so the extension can update their status.',
  "I understand that trade offers have a time limit. If the other party doesn't accept in time, the trade may be cancelled and I may need to create a new one.",
];

interface RulesModalProps {
  onClose: () => void;
  onConfirm: () => void;
}

/** "Extension rules" modal — Confirm stays disabled until all three rules are acknowledged. */
export function RulesModal({ onClose, onConfirm }: RulesModalProps) {
  const [checked, setChecked] = useState<boolean[]>([false, false, false]);
  const allChecked = checked.every(Boolean);

  const toggle = (index: number): void => {
    setChecked((prev) => prev.map((value, i) => (i === index ? !value : value)));
  };

  return (
    <ModalShell onClose={onClose}>
      <div class="modal__body">
        <p class="rules__intro">
          Before activating trade tracking, you must understand how trade verification works with the
          DMarket Trade Tracker extension.
        </p>

        <div class="rules__list">
          {RULES.map((text, index) => (
            <label class="rule" key={index}>
              <span class={checked[index] ? 'rule__box rule__box--checked' : 'rule__box'}>
                {checked[index] && (
                  <svg width="10" height="8" viewBox="0 0 10 8" xmlns="http://www.w3.org/2000/svg">
                    <path
                      d="M1 4L3.6 6.5L9 1"
                      fill="none"
                      stroke="#121212"
                      stroke-width="1.6"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                )}
              </span>
              <input
                type="checkbox"
                checked={checked[index]}
                onChange={() => toggle(index)}
                style="position:absolute;opacity:0;width:0;height:0;"
              />
              <span class="rule__label">{text}</span>
            </label>
          ))}
        </div>

        <button
          type="button"
          class="button--accent"
          style="width:100%;"
          disabled={!allChecked}
          onClick={onConfirm}
        >
          Confirm
        </button>
      </div>
    </ModalShell>
  );
}
