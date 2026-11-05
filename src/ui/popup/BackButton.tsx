import { icons } from './icons';

/** The "← Back" row at the top of a sub-view of the popup. */
export function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" class="back-button" onClick={onClick}>
      <img class="back-button__icon" src={icons.arrowBack} alt="" />
      Back
    </button>
  );
}
