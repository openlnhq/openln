// Shim: the lawalletio class module mutates its NfcManager instance with all
// the NTAG424 methods; transceive is routed to the current test target.
const manager = {
  transceive: async (bytes) => globalThis.__ORACLE_TRANSCEIVE__(bytes),
};
export default manager;
