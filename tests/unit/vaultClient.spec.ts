import { VaultClient } from '../../src/services/vaultClient'

describe('VaultClient', () => {
    const endpoint = 'https://vault.example'
    let client: VaultClient

    beforeEach(() => {
        client = new VaultClient(endpoint)
    })

    describe('URL construction', () => {
        it('should construct URL with endpoint and v1 prefix', async () => {
            const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: {} }))

            await client.read('secret/my-secret')

            expect(fetchSpy).toHaveBeenCalledWith('https://vault.example/v1/secret/my-secret', expect.any(Object))
        })
    })

    describe('headers', () => {
        it('should omit X-Vault-Token when token is not set', async () => {
            const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}))

            await client.read('secret/path')

            const headers = fetchSpy.mock.calls[0][1]!.headers as Record<string, string>

            expect(headers).not.toHaveProperty('X-Vault-Token')
        })

        it('should include X-Vault-Token when token is set', async () => {
            client.token = 'my-token'
            const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}))

            await client.read('secret/path')

            const headers = fetchSpy.mock.calls[0][1]!.headers as Record<string, string>

            expect(headers['X-Vault-Token']).toBe('my-token')
        })

        it('should not include Content-Type on GET requests', async () => {
            const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}))

            await client.read('secret/path')

            const headers = fetchSpy.mock.calls[0][1]!.headers as Record<string, string>

            expect(headers).not.toHaveProperty('Content-Type')
        })

        it('should include Content-Type on POST requests with body', async () => {
            const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}))

            await client.write('sys/leases/renew', { lease_id: 'abc' })

            const headers = fetchSpy.mock.calls[0][1]!.headers as Record<string, string>

            expect(headers['Content-Type']).toBe('application/json')
        })
    })

    describe('read', () => {
        it('should send GET request and return parsed JSON', async () => {
            const body = { data: { password: 'secret' }, lease_id: 'lid', lease_duration: 300 }

            vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(body))

            const result = await client.read('secret/my-secret')

            expect(result).toEqual(body)
        })
    })

    describe('write', () => {
        it('should send POST request with JSON body', async () => {
            const responseBody = { lease_duration: 600 }
            const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(responseBody))

            const result = await client.write('sys/leases/renew', { lease_id: 'lid' })

            expect(result).toEqual(responseBody)
            expect(fetchSpy).toHaveBeenCalledWith(
                'https://vault.example/v1/sys/leases/renew',
                expect.objectContaining({
                    method: 'POST',
                    body: JSON.stringify({ lease_id: 'lid' }),
                }),
            )
        })
    })

    describe('kubernetesLogin', () => {
        it('should construct correct URL with kubernetesPath', async () => {
            const responseBody = { auth: { client_token: 'tok', lease_duration: 100, accessor: 'a', service_account_name: 'sa' } }
            const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(responseBody))

            await client.kubernetesLogin({ jwt: 'jwt-token', role: 'my-role', kubernetesPath: 'kubernetes' })

            expect(fetchSpy).toHaveBeenCalledWith(
                'https://vault.example/v1/auth/kubernetes/login',
                expect.objectContaining({
                    method: 'POST',
                    body: JSON.stringify({ jwt: 'jwt-token', role: 'my-role' }),
                }),
            )
        })

        it('should return auth data', async () => {
            const responseBody = { auth: { client_token: 'tok', lease_duration: 100, accessor: 'a', service_account_name: 'sa' } }

            vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(responseBody))

            const result = await client.kubernetesLogin({ jwt: 'jwt', role: 'role', kubernetesPath: 'kubernetes' })

            expect(result.auth.client_token).toBe('tok')
        })
    })

    describe('tokenRenewSelf', () => {
        it('should POST to auth/token/renew-self', async () => {
            const responseBody = { auth: { lease_duration: 300 } }
            const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(responseBody))

            const result = await client.tokenRenewSelf()

            expect(fetchSpy).toHaveBeenCalledWith(
                'https://vault.example/v1/auth/token/renew-self',
                expect.objectContaining({ method: 'POST' }),
            )
            expect(result.auth.lease_duration).toBe(300)
        })
    })

    describe('tokenRevokeSelf', () => {
        it('should POST to auth/token/revoke-self and return null on 204', async () => {
            const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))

            const result = await client.tokenRevokeSelf()

            expect(fetchSpy).toHaveBeenCalledWith(
                'https://vault.example/v1/auth/token/revoke-self',
                expect.objectContaining({ method: 'POST' }),
            )
            expect(result).toBeNull()
        })
    })

    describe('error handling', () => {
        it('should throw with Vault error message from errors array', async () => {
            vi.spyOn(globalThis, 'fetch').mockResolvedValue(
                Response.json({ errors: ['permission denied'] }, { status: 403, statusText: 'Forbidden' }),
            )

            await expect(client.read('secret/forbidden')).rejects.toThrow('permission denied')
        })

        it('should fall back to statusText when no errors array', async () => {
            vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}, { status: 500, statusText: 'Internal Server Error' }))

            await expect(client.read('secret/broken')).rejects.toThrow('Internal Server Error')
        })
    })

    describe('token property', () => {
        it('should be null by default', () => {
            expect(client.token).toBeNull()
        })

        it('should be assignable', () => {
            client.token = 'new-token'

            expect(client.token).toBe('new-token')
        })
    })
})
