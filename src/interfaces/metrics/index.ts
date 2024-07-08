export interface VaultRequestsTotalLabelsMap {
    status: 'success' | 'failure'
    method: 'renew_token' | 'get_secret' | 'renew_lease'
}
