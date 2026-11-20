declare module '#mobiup-activation-store' {
  export const verifySim:typeof import('./sim-verification-node').verifySim;
  export const readVodafoneBonusAsync:typeof import('./vodafone-bonus-runtime-node').readVodafoneBonusAsync;
  export const readDigiOverview:typeof import('./vodafone-focus-runtime-node').readDigiOverview;
  export const readVodafoneFocus:typeof import('./vodafone-focus-runtime-node').readVodafoneFocus;
  export const readActivations:typeof import('./activation-store-node').readActivations;
}
