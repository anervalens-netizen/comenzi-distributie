declare module '#mobiup-activation-store' {
  export const verifySim:typeof import('./sim-verification-node').verifySim;
  export const readActivations:typeof import('./activation-store-node').readActivations;
}
