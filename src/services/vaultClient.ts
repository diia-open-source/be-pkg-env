export class VaultClient {
    token: string | null = null

    constructor(private readonly endpoint: string) {}

    async kubernetesLogin(opts: { jwt: string; role: string; kubernetesPath: string }): Promise<{
        auth: {
            client_token: string
            lease_duration: number
            accessor: string
            service_account_name: string
        }
    }> {
        return await this.request<{
            auth: {
                client_token: string
                lease_duration: number
                accessor: string
                service_account_name: string
            }
        }>('POST', `auth/${opts.kubernetesPath}/login`, {
            jwt: opts.jwt,
            role: opts.role,
        })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async read(path: string): Promise<any> {
        return await this.request('GET', path)
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async write(path: string, body: Record<string, unknown>): Promise<any> {
        return await this.request('POST', path, body)
    }

    async tokenRenewSelf(): Promise<{ auth: { lease_duration: number } }> {
        return await this.request<{ auth: { lease_duration: number } }>('POST', 'auth/token/renew-self')
    }

    async tokenRevokeSelf(): Promise<void> {
        return await this.request<void>('POST', 'auth/token/revoke-self')
    }

    private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
        const url = `${this.endpoint}/v1/${path}`
        const res = await fetch(url, {
            method,
            headers: this.getHeaders(body !== undefined),
            body: body === undefined ? undefined : JSON.stringify(body),
        })
        const json = res.status === 204 ? null : await res.json()
        if (!res.ok) {
            const msg = json?.errors?.[0] ?? res.statusText

            throw new Error(msg)
        }

        return json as T
    }

    private getHeaders(hasBody: boolean): Record<string, string> {
        const h: Record<string, string> = {}

        if (this.token) {
            h['X-Vault-Token'] = this.token
        }

        if (hasBody) {
            h['Content-Type'] = 'application/json'
        }

        return h
    }
}
