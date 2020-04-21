module.exports.erc1155TokenTerm = (nonce, publicKey) => {
  return `new 
  mainCh,
  createTokenCh,
  purchaseCh,
  entryCh,
  entryUriCh,
  setLockedCh,
  updateTokenDataCh,
  updateUriCh,
  hashCh,
  verifySignatureCh,
  tokens,
  tokensData,
  verifySignatureAndUpdateNonceCh,
  insertArbitrary(\`rho:registry:insertArbitrary\`),
  stdout(\`rho:io:stdout\`),
  secpVerify(\`rho:crypto:secp256k1Verify\`),
  blake2b256(\`rho:crypto:blake2b256Hash\`),
  revAddress(\`rho:rev:address\`),
  registryLookup(\`rho:registry:lookup\`)
in {


  /*
    tokens: {
      [uniqueId: String (incremental id)]: {
        publicKey: String (public key),
        n: Nil \\/ String (token id),
        price: Nil \\/ Int
        quantity: Int
      }
    }
  */
  tokens!({}) |

  /*
    tokensData: {
      [n: Strig (token id)]: String (registry URI)
    }
  */
  tokensData!({}) |

  for (@(payload, returnCh) <= verifySignatureAndUpdateNonceCh) {
    stdout!("verifySignatureAndUpdateNonceCh") |
    match payload {
      { "newNonce": String, "signature": String} => {
        for (@current <<- mainCh) {
          blake2b256!(
            current.get("nonce").toUtf8Bytes(),
            *hashCh
          ) |
          for (@hash <- hashCh) {
            secpVerify!(
              hash,
              payload.get("signature").hexToBytes(),
              current.get("publicKey").hexToBytes(),
              *verifySignatureCh
            )
          } |
          for (@result <- verifySignatureCh) {
            match result {
              true => {
                @returnCh!(true) |
                for (@c <- mainCh) {
                  mainCh!(c.set("nonce", payload.get("newNonce")))
                }
              }
              false => {
                @returnCh!("error: Invalid signature, could not perform operation")
              }
            }
          }
        }
      }
      _ => {
        @returnCh!("error: invalid payload, structure should be { 'newNonce': String, 'signature': String }")
      }
    }
  } |

  contract setLockedCh(payload, return) = {
    stdout!("setLockedCh") |

    for (@current <<- mainCh) {
      match current.get("locked") {
        true => {
          return!("error: contract is already locked")
        }
        false => {
          new verifyCh in {
            verifySignatureAndUpdateNonceCh!((
              {
                "newNonce": *payload.get("newNonce"),
                "signature": *payload.get("signature"),
              },
              *verifyCh
            )) |
            for (@verified <- verifyCh) {
              match verified {
                true => {
                  for (@c <- mainCh) {
                    mainCh!(c.set("locked", true))
                  } |
                  return!(true)
                }
                err => {
                  return!(err)
                }
              }
            }
          }
        }
      }
    }
  } |

  contract updateTokenDataCh(payload, return) = {
    stdout!("updateTokenDataCh") |

    for (@current <<- mainCh) {
      match current.get("locked") {
        true => {
          return!("error: contract is locked, cannot update token data")
        }
        false => {
          new verifyCh in {
            verifySignatureAndUpdateNonceCh!((
              {
                "newNonce": *payload.get("newNonce"),
                "signature": *payload.get("signature"),
              },
              *verifyCh
            )) |
            for (@verified <- verifyCh) {
              match verified {
                true => {
                  for (@currentTokensData <- tokensData) {
                    tokensData!(
                      currentTokensData.set(*payload.get("n"), *payload.get("data"))
                    )
                  } |
                  return!(true)
                }
                err => {
                  return!(err)
                }
              }
            }
          }
        }
      }
    }
  } |

  // add a token (1 or more)
  contract createTokenCh(payload, return) = {
    stdout!("createTokenCh") |

    for (@current <<- mainCh) {
      match current.get("locked") {
        true => {
          return!("error: contract is locked, cannot create token")
        }
        false => {
          for (@currentTokens <- tokens) {
            new verifyCh in {
              verifySignatureAndUpdateNonceCh!((
                {
                  "newNonce": *payload.get("newNonce"),
                  "signature": *payload.get("signature"),
                },
                *verifyCh
              )) |
              for (@verified <- verifyCh) {
                match verified {
                  true => {
                    match "\${n}" %% { "n": currentTokens.size() } {
                      uniqueId => {
                        new nCh in {

                          match *payload.get("n") {
                            // token n already exists
                            String => { nCh!(*payload.get("n")) }
                            // token n does not exist, unique ID will be used as n
                            _ => { nCh!(uniqueId) }
                          } |

                          for (@n <- nCh) {

                            tokens!(
                              currentTokens.set(uniqueId, {
                                "quantity": *payload.get("quantity"),
                                "publicKey": *payload.get("publicKey"),
                                "n": n,
                                "price": *payload.get("price"),
                              })
                            ) |

                            match *payload.get("data") {
                              Nil => {}
                              data => {
                                for (@currentTokensData <- tokensData) {
                                  tokensData!(
                                    currentTokensData.set(n, data)
                                  )
                                }
                              }
                            } |

                            return!(true)
                          }
                        }
                      }
                    }
                  }
                  err => {
                    return!(err)
                  }
                }
              }
            }
          }
        }
      }
    }
  } |

  // purchase token (1 or more)
  contract purchaseCh(payload, return) = {
    stdout!("purchaseCh") |
    stdout!(*payload) |
    for (@currentTokens <- tokens) {
      stdout!(currentTokens) |
      stdout!(currentTokens.get(*payload.get("uniqueId"))) |
      match currentTokens.get(*payload.get("uniqueId")) {
        Nil => {
          tokens!(currentTokens) |
          return!("error : token (unique ID) " ++ *payload.get("uniqueId") ++ " does not exist")
        }
        token => {
          stdout!(("purchaseCh", 10)) |
          match token.get("quantity") - *payload.get("quantity") >= 0 {
            false => {
              tokens!(currentTokens) |
              return!("error : not enough tokens (unique ID) " ++ *payload.get("uniqueId") ++ " available")
            }
            true => {
              stdout!(("purchaseCh", 11)) |
              new RevVaultCh, ownerRevAddressCh in {

                registryLookup!(\`rho:rchain:revVault\`, *RevVaultCh) |
                revAddress!("fromPublicKey", token.get("publicKey").hexToBytes(), *ownerRevAddressCh) |

                for (@(_, RevVault) <- RevVaultCh; @ownerRevAddress <- ownerRevAddressCh) {
                  match (
                    *payload.get("purseRevAddr"),
                    ownerRevAddress,
                    *payload.get("quantity") * token.get("price")
                  ) {
                    (from, to, amount) => {
                      stdout!((
                        4,
                        *payload.get("purseRevAddr"),
                        ownerRevAddress,
                        *payload.get("quantity") * token.get("price")
                      )) |
                      new purseVaultCh in {
                        @RevVault!("findOrCreate", from, *purseVaultCh) |
                        for (@(true, purseVault) <- purseVaultCh) {

                          new resultCh in {
                            @purseVault!("transfer", to, amount, *payload.get("purseAuthKey"), *resultCh) |
                            for (@result <- resultCh) {

                              match result {
                                (true, Nil) => {
                                  match "\${uniqueId}" %% { "uniqueId": currentTokens.size() } {
                                    uniqueId => {
                                      tokens!(
                                        // New unique ID for new token ownership
                                        currentTokens.set(uniqueId, {
                                          "quantity": *payload.get("quantity"),
                                          "publicKey": *payload.get("publicKey"),
                                          "n": token.get("n"),
                                          "price": Nil,
                                        // Udate quantity in seller token ownership
                                        }).set(*payload.get("uniqueId"), {
                                          "quantity": token.get("quantity") - *payload.get("quantity"),
                                          "publicKey": token.get("publicKey"),
                                          "n": token.get("n"),
                                          "price": token.get("price"),
                                        })
                                      ) |
                                      return!(true)
                                    }
                                  }
                                }
                                _ => {
                                  tokens!(currentTokens) |
                                  return!("error : REV transfer went wrong " ++ result.nth(2))
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  } |

  contract entryCh(action, return) = {
    match *action.get("type") {
      "READ_TOKENS" => {
        for (currentTokens <<- tokens) {
          return!(*currentTokens)
        }
      }
      "READ_TOKENS_DATA" => {
        for (@currentTokensData <<- tokensData) {
          return!(currentTokensData)
        }
      }
      "READ" => {
        for (current <<- mainCh) {
          return!(*current)
        }
      }
      "SET_LOCKED" => {
        match *action.get("payload") {
          { "locked": true, "signature": String, "newNonce": String } => {
            setLockedCh!(*action.get("payload"), *return)
          }
          _ => {
            return!("error: invalid payload, structure should be { 'signature': String, 'newNonce': String, 'locked': Boolean }")
          }
        }
      }
      "UPDATE_TOKEN_DATA" => {
        match *action.get("payload") {
          { "signature": String, "newNonce": String, "n": String, "data": _ } => {
            updateTokenDataCh!(*action.get("payload"), *return)
          }
          _ => {
            return!("error: invalid payload, structure should be { 'signature': String, 'newNonce': String, 'n': String, 'data': _ }")
          }
        }
      }
      "CREATE_TOKEN" => {
        match *action.get("payload") {
          { "signature": String, "newNonce": String, "quantity": Int, "publicKey": String, "price": Nil \\/ Int, "n": Nil \\/ String, "data": _ } => {
            createTokenCh!(*action.get("payload"), *return)
          }
          _ => {
            return!("error: invalid payload, structure should be { 'signature': String, 'newNonce': String, quantity': Int, 'n': Nil or String, 'price': Nil or Int, 'publicKey': String, 'data': _ }")
          }
        }
      }
      "PURCHASE_TOKEN" => {
        match *action.get("payload") {
          { "quantity": Int, "uniqueId": String, "publicKey": String, "purseRevAddr": _, "purseAuthKey": _ } => {
            purchaseCh!(*action.get("payload"), *return)
          }
          _ => {
            return!("error: invalid payload, structure should be { 'quantity': Int, 'n': Int, 'publicKey': String }")
          }
        }
      }
      _ => {
        return!("error: unknown action")
      }
    }
  } |

  insertArbitrary!(*entryCh, *entryUriCh) |

  for (entryUri <- entryUriCh) {

    mainCh!({
      "registryUri": *entryUri,
      "locked": false,
      "publicKey": "${publicKey}",
      "nonce": "${nonce}",
      "version": "0.1"
    }) |
    stdout!({
      "registryUri": *entryUri,
      "locked": false,
      "publicKey": "${publicKey}",
      "nonce": "${nonce}",
      "version": "0.1"
    })
  }
}`;
};