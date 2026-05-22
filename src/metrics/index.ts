import { Counter } from '@diia-inhouse/diia-metrics'

import { VaultRequestsTotalLabelsMap } from '../interfaces/metrics/index.js'

export const vaultRequestsTotalMetric: Counter<VaultRequestsTotalLabelsMap> = new Counter<VaultRequestsTotalLabelsMap>(
    'vault_requests_total',
    ['status', 'method'],
)
