import { RPCRequest, RPCResponse } from '../../types/config'
import config from '../config'
import axios from 'axios'
import * as util from 'ethereumjs-util'
import *  as verify from '../../client/verify'
import * as evm from './evm'
import * as request from 'request';
import { RPCHandler } from '../rpc';



let counter = 1


/**
 * main function to handle rpc-calls
 */
export async function handle(request: RPCRequest): Promise<RPCResponse> {
  const proof = request.in3Verification || 'never'
  if (proof === 'proof' || proof === 'proofWithSignature') {

    if (request.method === 'eth_getTransactionByHash')
      return handeGetTransaction(request)
    if (request.method === 'eth_call')
      return handleCall(request)
    if (request.method === 'eth_getCode' || request.method === 'eth_getBalance' || request.method === 'eth_getTransactionCount' || request.method === 'eth_getStorageAt')
      return handleAccount(request)
  }

  return getFromServer(request)
}


function getFromServer(request: Partial<RPCRequest>): Promise<RPCResponse> {
  if (!request.id) request.id = counter++
  if (!request.jsonrpc) request.jsonrpc = '2.0'
  return axios.post(config.rpcUrl, request).then(_ => _.data)
}

function getAllFromServer(request: Partial<RPCRequest>[]): Promise<RPCResponse[]> {
  console.log('req:', JSON.stringify(request, null, 2))
  return request.length
    ? axios.post(config.rpcUrl, request.filter(_ => _).map(_ => ({ id: counter++, jsonrpc: '2.0', ..._ }))).then(_ => _.data)
    : Promise.resolve([])
}

async function handeGetTransaction(request: RPCRequest): Promise<RPCResponse> {
  // ask the server for the tx
  const response = await getFromServer(request)
  const tx = response && response.result as any
  // if we have a blocknumber, it is mined and we can provide a proof over the blockhash
  if (tx && tx.blockNumber) {
    // get the block including all transactions from the server
    const block = await getFromServer({ method: 'eth_getBlockByNumber', params: [verify.toHex(tx.blockNumber), true] }).then(_ => _ && _.result as any)
    if (block)
      // create the proof
      response.in3Proof = await verify.createTransactionProof(block, request.params[0] as string, sign(block.hash, tx.blockNumber)) as any
  }
  return response
}

function toHex(adr: string, len: number) {
  let a = adr.startsWith('0x') ? adr.substr(2) : adr
  if (a.length > len * 2) a = a.substr(0, len * 2)
  while (a.length < len * 2)
    a += '0'
  return '0x' + a
}



function sign(blockHash, blockNumber): any {
  const msgHash = util.sha3('0x' + verify.toHex(blockHash).substr(2).padStart(64, '0') + verify.toHex(blockNumber).substr(2).padStart(64, '0'))
  const sig = util.ecsign(msgHash, util.toBuffer(config.privateKey))
  return {
    r: '0x' + sig.r.toString('hex'),
    s: '0x' + sig.s.toString('hex'),
    v: sig.v,
    msgHash: '0x' + msgHash.toString('hex')
  }

}






async function handleCall(request: RPCRequest): Promise<RPCResponse> {
  // read the response,blockheader and trace from server
  const [response, blockResponse, trace] = await getAllFromServer([
    request,
    { method: 'eth_getBlockByNumber', params: [request.params[1] || 'latest', false] },
    { method: 'trace_call', params: [request.params[0], ['vmTrace'], request.params[1] || 'latest'] }
  ])

  // error checking
  if (response.error) return response
  if (blockResponse.error) throw new Error('Could not get the block for ' + request.params[1] + ':' + blockResponse.error)
  if (trace.error) throw new Error('Could not get the trace :' + trace.error)

  // anaylse the transaction in order to find all needed storage
  const block = blockResponse.result as any
  const neededProof = evm.analyse((trace.result as any).vmTrace, request.params[0].to)

  // ask for proof for the storage
  const accountProofs = await getAllFromServer(Object.keys(neededProof.accounts).map(adr => (
    { method: 'eth_getProof', params: [toHex(adr, 20), Object.keys(neededProof.accounts[adr].storage).map(_ => toHex(_, 32)), block.number] }
  )))

  // add the codes to the accounts
  if (request.in3IncludeCode) {
    const accounts = accountProofs
      .filter(a => (a.result as any).codeHash !== '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470')
    const codes = await getAllFromServer(accounts.map(a => ({ method: 'eth_getCode', params: [toHex((a.result as any).address, 20), request.params[1] || 'latest'] })))
    accounts.forEach((r, i) => (accounts[i].result as any).code = codes[i])
  }

  // bundle the answer
  return {
    ...response,
    in3Proof: {
      type: 'callProof',
      block: verify.blockToHex(block),
      signature: sign(block.hash, block.number),
      accounts: Object.keys(neededProof.accounts).reduce((p, v, i) => { p[v] = accountProofs[i].result; return p }, {})
    }
  }
}


async function handleAccount(request: RPCRequest): Promise<RPCResponse> {

  const address = request.params[0] as string
  const blockNr = request.params[request.method === 'eth_getStorageAt' ? 2 : 1] || 'latest'
  const storage = request.method === 'eth_getStorageAt' ? [request.params[1]] : []

  // read the response,blockheader and trace from server
  const [blockResponse, proof, code] = await getAllFromServer([
    { method: 'eth_getBlockByNumber', params: [blockNr, false] },
    { method: 'eth_getProof', params: [toHex(address, 20), storage.map(_ => toHex(_, 32)), blockNr] },
    request.method === 'eth_getCode' ? request : null
  ])

  // error checking
  if (blockResponse.error) throw new Error('Could not get the block for ' + request.params[1] + ':' + blockResponse.error)
  if (proof.error) throw new Error('Could not get the proof :' + proof.error)

  // anaylse the transaction in order to find all needed storage
  const block = blockResponse.result as any
  const account = proof.result as any
  let result;
  if (request.method === 'eth_getBalance')
    result = account.balance
  else if (request.method === 'eth_getCode')
    result = code.result
  else if (request.method === 'eth_getTransactionCount')
    result = account.nonce
  else if (request.method === 'eth_getStorageAt')
    result = account.storageProof[0].value

  // bundle the answer
  return {
    id: request.id,
    jsonrpc: '2.0',
    result,
    in3Proof: {
      type: 'accountProof',
      block: verify.blockToHex(block),
      signature: sign(block.hash, block.number),
      account: proof.result
    }
  }
} 
