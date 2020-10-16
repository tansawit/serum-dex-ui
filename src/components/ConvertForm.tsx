import React, {useState} from 'react';
import {Button, Col, Input, Row, Select, Typography} from 'antd';
import styled from 'styled-components';
import {Orderbook} from '@project-serum/serum';
import {
  getMarketDetails,
  getMarketInfos,
  getMarketOrderPrice,
  getSelectedTokenAccountForMint,
  useBalances,
  useMarket,
  useTokenAccounts,
} from '../utils/markets';
import {notify} from '../utils/notifications';
import {useWallet} from '../utils/wallet';
import {useConnection, useSendConnection} from '../utils/connection';
import {placeOrder} from '../utils/send';
import {floorToDecimal, getDecimalCount} from '../utils/utils';
import FloatingElement from './layout/FloatingElement';
import WalletConnect from './WalletConnect';

const { Option } = Select;
const { Title } = Typography;

const ActionButton = styled(Button)`
  color: #2abdd2;
  background-color: #212734;
  border-width: 0px;
`;

const ConvertButton = styled(Button)`
  background: #02bf76;
  border-color: #02bf76;
`;

export default function ConvertForm() {
  const { connected, wallet } = useWallet();
  const { customMarkets } = useMarket();
  const marketInfos = getMarketInfos(customMarkets)
  const {market, setMarketAddress} = useMarket();

  const [fromToken, setFromToken] = useState<string | undefined>(undefined);
  const [toToken, setToToken] = useState<string | undefined>(undefined);
  const [size, setSize] = useState<number | undefined>(undefined);

  const marketInfosbyName = Object.fromEntries(marketInfos.map(market => [market.name, market]));

  const tokenConvertMap: Map<string, Set<string>> = new Map();
  Object.keys(marketInfosbyName).forEach((market) => {
    let [base, quote] = market.split('/');
    !tokenConvertMap.has(base)
      ? tokenConvertMap.set(base, new Set([quote]))
      : tokenConvertMap.set(base, new Set([...(tokenConvertMap.get(base) || []), quote]));
    !tokenConvertMap.has(quote)
      ? tokenConvertMap.set(quote, new Set([base]))
      : tokenConvertMap.set(quote, new Set([...(tokenConvertMap.get(quote) || []), base]));
  });

  const setMarket = (toToken) => {
    const marketInfo = marketInfos.filter(marketInfo => !marketInfo.deprecated).find(marketInfo =>
      marketInfo.name === `${fromToken}/${toToken}` || marketInfo.name === `${toToken}/${fromToken}`
    );
    if (!marketInfo) {
      console.warn(`Could not find market info for market names ${fromToken}/${toToken} or ${toToken}/${fromToken}`);
      notify({
        message: 'Invalid market',
        type: 'error',
      });
      return;
    }
    setMarketAddress(marketInfo.address.toBase58())
    setToToken(toToken);
  }

  return (
    <FloatingElement style={{ maxWidth: 500 }}>
      <Title level={3}>Convert</Title>
      {!connected && (
        <Row justify="center">
          <Col>
            <WalletConnect />
          </Col>
        </Row>
      )}
      {tokenConvertMap && connected && (
        <>
          <Row style={{ marginBottom: 8 }}>
            <Col>
              <Select
                style={{ minWidth: 300 }}
                placeholder="Select a token"
                value={fromToken}
                onChange={(token) => {
                  setFromToken(token);
                  setToToken(undefined);
                }}
              >
                {Array.from(tokenConvertMap.keys()).map((token) => (
                  <Option value={token} key={token}>
                    {token}
                  </Option>
                ))}
              </Select>
            </Col>
          </Row>
          {fromToken && (
            <Row style={{ marginBottom: 8 }}>
              <Col>
                <Select
                  style={{ minWidth: 300 }}
                  value={toToken}
                  onChange={setMarket}
                >
                  {[...(tokenConvertMap.get(fromToken) || [])].map((token) => (
                    <Option value={token} key={token}>
                      {token}
                    </Option>
                  ))}
                </Select>
              </Col>
            </Row>
          )}
          {fromToken && toToken && (
            <ConvertFormSubmit
              size={size}
              setSize={setSize}
              fromToken={fromToken}
              wallet={wallet}
              market={market}
              customMarkets={customMarkets}
            />
          )}
        </>
      )}
    </FloatingElement>
  );
}

function ConvertFormSubmit({
  size,
  setSize,
  fromToken,
  wallet,
  market,
  customMarkets
}) {
  const [accounts] = useTokenAccounts();
  const balances = useBalances()

  const connection = useConnection();
  const sendConnection = useSendConnection();

  const [isConverting, setIsConverting] = useState(false);

  const isFromTokenBaseOfMarket = (market) => {
    const { marketName } = getMarketDetails(market, customMarkets);
    if (!marketName) {
      throw Error('Cannot determine if coin is quote or base because marketName is missing');
    }
    const [base] = marketName.split('/');
    return fromToken === base;
  };

  const onConvert = async () => {
    if (!market) {
      console.warn('Market is null when attempting convert.');
      notify({
        message: 'Invalid market',
        type: 'error',
      });
      return;
    }
    // get accounts
    const baseCurrencyAccount = getSelectedTokenAccountForMint(
      accounts,
      market?.baseMintAddress,
    );
    const quoteCurrencyAccount = getSelectedTokenAccountForMint(
      accounts,
      market?.quoteMintAddress,
    );

    // get approximate price
    let side;
    try {
      side = isFromTokenBaseOfMarket(market) ? 'sell' : 'buy';
    } catch (e) {
      console.warn(e);
      notify({
        message: 'Error placing order',
        description: e.message,
        type: 'error',
      });
      return;
    }

    const sidedOrderbookAccount =
      // @ts-ignore
      side === 'buy' ? market._decoded.asks : market._decoded.bids;
    const orderbookData = await connection.getAccountInfo(sidedOrderbookAccount);
    if (!orderbookData?.data) {
      notify({ message: 'Invalid orderbook data', type: 'error' });
      return;
    }
    const decodedOrderbookData = Orderbook.decode(market, orderbookData.data);
    const [bbo] =
      decodedOrderbookData &&
      decodedOrderbookData.getL2(1).map(([price]) => price);
    if (!bbo) {
      notify({ message: 'No best price found', type: 'error' });
      return;
    }
    if (!size) {
      notify({ message: 'Size not specified', type: 'error' });
      return;
    }

    const parsedPrice = getMarketOrderPrice(decodedOrderbookData, size);

    // round size
    const sizeDecimalCount = getDecimalCount(market.minOrderSize);
    const nativeSize = side === 'sell' ? size : size / parsedPrice;
    const parsedSize = floorToDecimal(nativeSize, sizeDecimalCount);

    setIsConverting(true);
    try {
      await placeOrder({
        side,
        price: parsedPrice,
        size: parsedSize,
        orderType: 'ioc',
        market,
        connection: sendConnection,
        wallet,
        baseCurrencyAccount: baseCurrencyAccount?.pubkey,
        quoteCurrencyAccount: quoteCurrencyAccount?.pubkey,
      });
    } catch (e) {
      console.warn(e);
      notify({
        message: 'Error placing order',
        description: e.message,
        type: 'error',
      });
    } finally {
      setIsConverting(false);
    }
  };

  const canConvert = market && size && size > 0;
  const balance = balances.find(coinBalance => coinBalance.coin === fromToken);

  return (
    <React.Fragment>
      <Row style={{ marginBottom: 8 }}>
        <Col>
          <Input
            style={{ minWidth: 300 }}
            addonBefore={`Size (${fromToken})`}
            placeholder="Size"
            value={size}
            type="number"
            onChange={(e) => setSize(parseFloat(e.target.value))}
          />
        </Col>
      </Row>
      <Row gutter={12} style={{ marginBottom: 8 }}>
        <Col span={12}>
          <ActionButton
            block
            size="large"
            onClick={() => setSize((balance?.unsettled || 0.) + (balance?.wallet || 0.))}
          >
            Max: {((balance?.unsettled || 0.) + (balance?.wallet || 0.)).toFixed(4)}
          </ActionButton>
        </Col>
        <Col span={12}>
          <ConvertButton
            block
            type="primary"
            size="large"
            loading={isConverting}
            onClick={onConvert}
            disabled={!canConvert}
          >
            Convert
          </ConvertButton>
        </Col>
      </Row>
    </React.Fragment>
  );
}
