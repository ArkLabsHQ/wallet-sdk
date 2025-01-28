import { describe, expect, it } from 'vitest'
import { aggregateKeys } from '../src/core/musig2/keys'
import { sign } from '../src/core/musig2/sign'
import testData from './fixtures/musig2.json'
import { hex } from '@scure/base'

describe('musig2', () => {
  describe('aggregateKeys', () => {
    it('should correctly aggregate public keys', () => {
      const { pubkeys, expectedAggregatedKey, tweak, expectedFinalKey } = testData.keyAggregation
      const publicKeys = pubkeys.map(key => hex.decode(key))
      const { preTweakedKey, finalKey } = aggregateKeys(publicKeys, true, { taprootTweak: hex.decode(tweak) })
      expect(hex.encode(preTweakedKey.slice(1))).toBe(expectedAggregatedKey)
      expect(hex.encode(finalKey.slice(1))).toBe(expectedFinalKey)
    })
  })

  describe('sign', () => {
    it('should correctly generate signature', () => {
      const { inputs, result } = testData.signing
      const {
        secNonce,
        secretKey,
        pubNonce,
        publicKeys,
        message,
        options,
        aggNonce
      } = inputs

      const signature = sign(
        hex.decode(secNonce),
        hex.decode(pubNonce),
        hex.decode(secretKey),
        hex.decode(aggNonce),
        publicKeys.map(key => hex.decode(key)),
        hex.decode(message),
        {
          sortKeys: true,
          taprootTweak: hex.decode(options.taprootTweak)
        }
      )

      expect(hex.encode(signature.encode())).toBe(result)
    })
  })
})