import Logger from '@diia-inhouse/diia-logger'
import { DurationMs } from '@diia-inhouse/types'

import { EnvService } from '../../src'

xdescribe('EnvService', () => {
    const env = Object.assign({}, process.env)

    beforeEach(() => {
        process.env = env
    })

    afterEach(() => {
        process.env = env
    })

    // The test case for the development purposes. Currently integration tests are disabled on CI for this repo
    it('should init vault and get secrets', async () => {
        process.env.VAULT_ENABLED = 'true'
        process.env.VAULT_ADDR = ''
        process.env.VAULT_ROLE_ID = ''
        process.env.VAULT_SECRET_ID = ''
        const envService = new EnvService(new Logger())

        await envService.init()
        const secret = await envService.getSecret('mongodb/creds/shared-test', 'username')
        const retriedSecret = await envService.getSecret('mongodb/creds/shared-test', 'username')
        const retriedSecretAnotherPath = await envService.getSecret('mongodb/creds/shared-test', 'password')
        const staticSecret = await envService.getSecret('services/data/test', 'data')

        expect(secret).toEqual(retriedSecret)
        expect(retriedSecretAnotherPath).toBeDefined()
        expect(staticSecret).toBeDefined()

        await new Promise((resolve) => setTimeout(resolve, DurationMs.Second * 10))
    })
})
