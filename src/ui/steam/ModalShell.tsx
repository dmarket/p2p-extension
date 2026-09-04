import type { ComponentChildren } from 'preact';
import { steamIcons } from './icons';

interface ModalShellProps {
  onClose: () => void;
  children: ComponentChildren;
}

/** Centered overlay + card used by both onboarding modals. Title matches the Figma ("Extension rules"). */
export function ModalShell({ onClose, children }: ModalShellProps) {
  return (
    <div
      class="dmp backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div class="modal" role="dialog" aria-modal="true" aria-label="Extension rules">
        <div class="modal__header">
          <div class="icon-box modal__header-icon">
            <img src={steamIcons.glyphRun} alt="" />
          </div>
          <p class="modal__title">Extension rules</p>
          <button type="button" class="modal__close" onClick={onClose} aria-label="Close">
            <img src={steamIcons.close} alt="" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
