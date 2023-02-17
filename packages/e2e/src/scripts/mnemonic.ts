/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-floating-promises */
import * as Crypto from '@cardano-sdk/crypto';
import { AddressType, InMemoryKeyAgent, util } from '@cardano-sdk/key-management';
import { CML } from '@cardano-sdk/core';
import { localNetworkChainId } from '../util';

/**
 * Generates a new set of Mnemonic words and prints them to the console.
 */
(async () => {
  let mnemonic = '';
  const mnemonicArray = util.generateMnemonicWords();
  for (const word of mnemonicArray) mnemonic += `${word} `;

  const keyAgentFromMnemonic = await InMemoryKeyAgent.fromBip39MnemonicWords(
    {
      chainId: localNetworkChainId,
      getPassphrase: async () => Buffer.from(''),
      mnemonicWords: mnemonicArray
    },
    {
      bip32Ed25519: new Crypto.CmlBip32Ed25519(CML),
      inputResolver: { resolveInputAddress: async () => null },
      logger: console
    }
  );

  const derivedAddress = await keyAgentFromMnemonic.deriveAddress({
    index: 0,
    type: AddressType.External
  });

  console.log('');
  console.log(`  Mnemonic:   ${mnemonic}`);
  console.log('');
  console.log(`  Address:    ${derivedAddress.address}`);
  console.log('');
})();