import { ModalShell } from './ModalShell';
import { steamIcons } from './icons';

interface SuccessModalProps {
  onClose: () => void;
}

/** Confirmation shown after tracking is activated. */
export function SuccessModal({ onClose }: SuccessModalProps) {
  return (
    <ModalShell onClose={onClose}>
      <div class="success">
        <div class="success__body">
          <img class="success__icon" src={steamIcons.successCheck} alt="" />
          <p class="success__text">Everything is set</p>
        </div>
        <button type="button" class="button--accent" style="width:100%;" onClick={onClose}>
          Close
        </button>
      </div>
    </ModalShell>
  );
}
