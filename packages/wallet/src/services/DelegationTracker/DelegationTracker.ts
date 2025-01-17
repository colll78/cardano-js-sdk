import {
  Cardano,
  ChainHistoryProvider,
  DRepInfo,
  EraSummary,
  SlotEpochCalc,
  createSlotEpochCalc
} from '@cardano-sdk/core';
import { DelegationTracker, TransactionsTracker, UtxoTracker } from '../types';
import { GroupedAddress } from '@cardano-sdk/key-management';
import { Logger } from 'ts-log';
import { Observable, combineLatest, map, tap } from 'rxjs';
import {
  ObservableRewardsProvider,
  ObservableStakePoolProvider,
  createQueryStakePoolsProvider,
  createRewardAccountsTracker,
  createRewardsProvider
} from './RewardAccounts';
import { RetryBackoffConfig } from 'backoff-rxjs';
import { RewardsHistoryProvider, createRewardsHistoryProvider, createRewardsHistoryTracker } from './RewardsHistory';
import { Shutdown, contextLogger } from '@cardano-sdk/util';
import { TrackedRewardsProvider, TrackedStakePoolProvider } from '../ProviderTracker';
import { TrackerSubject } from '@cardano-sdk/util-rxjs';
import { TxWithEpoch } from './types';
import { WalletStores } from '../../persistence';
import { createDelegationDistributionTracker } from './DelegationDistributionTracker';
import { pollProvider } from '../util';
import { transactionsWithCertificates } from './transactionCertificates';

export const createBlockEpochProvider =
  (chainHistoryProvider: ChainHistoryProvider, retryBackoffConfig: RetryBackoffConfig, logger: Logger) =>
  (ids: Cardano.BlockId[]) =>
    pollProvider({
      logger,
      retryBackoffConfig,
      sample: () => chainHistoryProvider.blocksByHashes({ ids })
    }).pipe(map((blocks) => blocks.map(({ epoch }) => epoch)));

export type BlockEpochProvider = ReturnType<typeof createBlockEpochProvider>;

export interface DelegationTrackerProps {
  drepInfo$: (drepIds: Cardano.DRepID[]) => Observable<DRepInfo[]>;
  rewardsTracker: TrackedRewardsProvider;
  rewardAccountAddresses$: Observable<Cardano.RewardAccount[]>;
  stakePoolProvider: TrackedStakePoolProvider;
  eraSummaries$: Observable<EraSummary[]>;
  epoch$: Observable<Cardano.EpochNo>;
  transactionsTracker: TransactionsTracker;
  retryBackoffConfig: RetryBackoffConfig;
  utxoTracker: UtxoTracker;
  knownAddresses$: Observable<GroupedAddress[]>;
  stores: WalletStores;
  internals?: {
    queryStakePoolsProvider?: ObservableStakePoolProvider;
    rewardsProvider?: ObservableRewardsProvider;
    rewardsHistoryProvider?: RewardsHistoryProvider;
    slotEpochCalc$?: Observable<SlotEpochCalc>;
  };
  logger: Logger;
}

export const certificateTransactionsWithEpochs = (
  transactionsTracker: TransactionsTracker,
  rewardAccountAddresses$: Observable<Cardano.RewardAccount[]>,
  slotEpochCalc$: Observable<SlotEpochCalc>,
  certificateTypes: Cardano.CertificateType[]
): Observable<TxWithEpoch[]> =>
  combineLatest([
    transactionsWithCertificates(transactionsTracker.history$, rewardAccountAddresses$, certificateTypes),
    slotEpochCalc$
  ]).pipe(
    map(([transactions, slotEpochCalc]) =>
      transactions.map((tx) => ({ epoch: slotEpochCalc(tx.blockHeader.slot), tx }))
    )
  );

const hasDelegationCert = (certificates: Array<Cardano.Certificate> | undefined): boolean =>
  !!certificates &&
  certificates.some((cert) =>
    Cardano.isCertType(cert, [...Cardano.RegAndDeregCertificateTypes, ...Cardano.StakeDelegationCertificateTypes])
  );

export const createDelegationPortfolioTracker = (transactions: Observable<Cardano.HydratedTx[]>) =>
  transactions.pipe(
    map((hydratedTxs) => {
      const sortedTransactions = [...hydratedTxs].reverse();

      let result = null;
      for (const sorted of sortedTransactions) {
        const portfolio = sorted.auxiliaryData?.blob?.get(Cardano.DelegationMetadataLabel);
        const altersDelegationState = hasDelegationCert(sorted.body.certificates);

        if (!portfolio && !altersDelegationState) continue;

        if (altersDelegationState && !portfolio) {
          result = null;
          break;
        }

        if (portfolio) {
          result = Cardano.cip17FromMetadatum(portfolio);
          break;
        }
      }

      return result;
    })
  );

export const createDelegationTracker = ({
  drepInfo$,
  rewardAccountAddresses$,
  epoch$,
  rewardsTracker,
  retryBackoffConfig,
  transactionsTracker,
  eraSummaries$,
  stakePoolProvider,
  knownAddresses$,
  utxoTracker,
  stores,
  logger,
  internals: {
    queryStakePoolsProvider = createQueryStakePoolsProvider(
      stakePoolProvider,
      stores.stakePools,
      retryBackoffConfig,
      logger
    ),
    rewardsHistoryProvider = createRewardsHistoryProvider(rewardsTracker, retryBackoffConfig),
    rewardsProvider = createRewardsProvider(
      epoch$,
      transactionsTracker.outgoing.onChain$,
      rewardsTracker,
      retryBackoffConfig,
      logger
    ),
    slotEpochCalc$ = eraSummaries$.pipe(map((eraSummaries) => createSlotEpochCalc(eraSummaries)))
  } = {}
}: DelegationTrackerProps): DelegationTracker & Shutdown => {
  const transactions$ = certificateTransactionsWithEpochs(
    transactionsTracker,
    rewardAccountAddresses$,
    slotEpochCalc$,
    [
      ...new Set([
        ...Cardano.RegAndDeregCertificateTypes,
        ...Cardano.StakeDelegationCertificateTypes,
        ...Cardano.VoteDelegationCredentialCertificateTypes
      ])
    ]
  ).pipe(tap((transactionsWithEpochs) => logger.debug(`Found ${transactionsWithEpochs.length} staking transactions`)));

  const rewardsHistory$ = new TrackerSubject(
    createRewardsHistoryTracker(
      transactions$,
      rewardAccountAddresses$,
      rewardsHistoryProvider,
      stores.rewardsHistory,
      contextLogger(logger, 'rewardsHistory$')
    )
  );

  const portfolio$ = new TrackerSubject(createDelegationPortfolioTracker(transactionsTracker.history$));

  const rewardAccounts$ = new TrackerSubject(
    createRewardAccountsTracker({
      balancesStore: stores.rewardsBalances,
      drepInfo$,
      epoch$,
      rewardAccountAddresses$,
      rewardsProvider,
      stakePoolProvider: queryStakePoolsProvider,
      transactions$,
      transactionsInFlight$: transactionsTracker.outgoing.inFlight$
    })
  );
  const distribution$ = new TrackerSubject(
    createDelegationDistributionTracker({ knownAddresses$, rewardAccounts$, utxoTracker })
  );
  return {
    distribution$,
    portfolio$,
    rewardAccounts$,
    rewardsHistory$,
    shutdown: () => {
      rewardAccounts$.complete();
      rewardsHistory$.complete();
      portfolio$.complete();
      logger.debug('Shutdown');
    }
  };
};
