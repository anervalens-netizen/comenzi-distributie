declare module '#mobiup-activation-store' {
  export const activationPublicationVersion:typeof import('./activation-publication-node').activationPublicationVersion;
  export const readCombinedActivationPartners:typeof import('./activation-partners-runtime-node').readCombinedActivationPartners;
  export const verifySim:typeof import('./sim-verification-node').verifySim;
  export const readVodafoneSim0RankingAsync:typeof import('./vodafone-bonus-runtime-node').readVodafoneSim0RankingAsync;
  export const readVodafoneBonusAsync:typeof import('./vodafone-bonus-runtime-node').readVodafoneBonusAsync;
  export const readDigiOverview:typeof import('./vodafone-focus-runtime-node').readDigiOverview;
  export const readVodafoneFocus:typeof import('./vodafone-focus-runtime-node').readVodafoneFocus;
  export const readActivations:typeof import('./activation-store-node').readActivations;
}
