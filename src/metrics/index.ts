import { VaultRequestsTotalLabelsMap } from 'src/interfaces/metrics'

import { Counter } from '@diia-inhouse/diia-metrics'

export const vaultRequestsTotalMetric = new Counter<VaultRequestsTotalLabelsMap>('vault_requests_total', ['status', 'method'])
