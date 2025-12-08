import { ConnectButton, useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from "@mysten/dapp-kit";
import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { Table, Text, Button, Card, Flex, Tooltip, IconButton, Grid, Checkbox, Heading, TextArea } from "@radix-ui/themes";
import { useState, useEffect } from "react";
import { MAINNET_NEMO_PACKAGE_ID, MAINNET_REPAY_PACKAGE_ID, MAINNET_REPAY_REGISTRY_ID, ASSET_TYPES } from "./constants";

const NEOM_TYPE = `${MAINNET_REPAY_PACKAGE_ID}::neom::NEOM`;

// Hardcode mainnet client to ensure we query the correct chain regardless of wallet/provider state
const MAINNET_RPC_URL = "https://fullnode.mainnet.sui.io:443";
const mainnetClient = new SuiClient({ url: MAINNET_RPC_URL });

// Helper component for copying text
function BlockCopy({ text }: { text: string }) {
    const [copied, setCopied] = useState(false);

    const handleCopy = () => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <Flex align="center" gap="2">
            <Text size="1" style={{ wordBreak: 'break-all' }}>{text}</Text>
            <Tooltip content={copied ? "Copied!" : "Copy"}>
                <IconButton size="1" variant="ghost" onClick={handleCopy}>
                    {copied ? "✓" : "📋"}
                </IconButton>
            </Tooltip>
        </Flex>
    );
}

// Include NEOM in the default list for selection
const ALL_ASSETS = [...ASSET_TYPES];

export function MultiAssetClaim() {
    const [addressesInput, setAddressesInput] = useState<string>("");
    // Default select all assets
    const [selectedAssets, setSelectedAssets] = useState<Set<string>>(new Set(ALL_ASSETS));
    // Results grouped by address
    const [results, setResults] = useState<Record<string, { type: string, amount: string, underlying: string }[]>>({});
    const [isLoading, setIsLoading] = useState(false);

    // Cache for Market ID per Asset Type
    const [marketMap, setMarketMap] = useState<Record<string, string>>({});
    // Cache for Decimals (Asset -> Decimals)
    const [decimalsMap, setDecimalsMap] = useState<Record<string, number>>({});

    const client = useSuiClient();

    useEffect(() => {
        const initData = async () => {
            // 1. Fetch Market Created Events to map Asset Type -> Market State ID
            // We query for the MarketCreatedEvent in the package
            // Note: This matches "0x...::market::MarketCreatedEvent" or similar?
            // Checking market.move: `struct MarketState<phantom T0>`. Creation via `create`.
            // Event emitted? No explicit "MarketCreated" event in `create` function in `market.move`.
            // Wait, `create` (line 149) does NOT emit an event?
            // It shares the object: `0x2::transfer::share_object<MarketState<T0>>(v0);`
            // So we might need to query for SHARED OBJECTS of type `MarketState<T0>`.
            // Or maybe `MarketFactory` emits an event?
            // Let's check `market_factory.move` if needed.
            // For now, let's try querying `AddLiquidityEvent` which definitely exists and contains `market_state_id`.

            try {
                // Fetch Market IDs by querying user's interaction history (AddLiquidity events)
                // This is more reliable for finding markets the USER is interested in / has positions in.
                // Fetch ALL MarketCreatedEvents to build a comprehensive map
                // We use the original factory package ID: 0x2b71664477755b90f9fb71c9c944d5d0d3832fec969260e3f18efc7d855f57c4
                // We need to paginate to get all markets.

                let cursor = null;
                let hasNextPage = true;
                const allMarketEvents: any[] = [];
                const MARKET_FACTORY_PKG = "0x2b71664477755b90f9fb71c9c944d5d0d3832fec969260e3f18efc7d855f57c4";

                console.log("Fetching all market definitions...");

                while (hasNextPage) {
                    const result = await client.queryEvents({
                        query: {
                            MoveModule: {
                                package: MARKET_FACTORY_PKG,
                                module: "market_factory"
                            }
                        },
                        cursor: cursor,
                        limit: 50
                    });

                    allMarketEvents.push(...result.data);
                    hasNextPage = result.hasNextPage;
                    cursor = result.nextCursor;

                    if (allMarketEvents.length > 500) break; // Safety break, though markets shouldn't be that many?
                }

                console.log("Total Market Definitions found:", allMarketEvents.length);

                const newMarketMap: Record<string, string> = {};
                allMarketEvents.forEach(e => {
                    if (e.type.includes("::market_factory::MarketCreatedEvent")) {
                        // Extract T0. Type format: 0x...::market_factory::MarketCreatedEvent<T0>
                        const match = e.type.match(/<(.+)>/);
                        if (match && e.parsedJson) {
                            const assetType = match[1];
                            const data = e.parsedJson as any;
                            newMarketMap[assetType] = data.market_id;
                        }
                    }
                });

                setMarketMap(prev => ({ ...prev, ...newMarketMap }));

                // Also fetch decimals for known assets
                const assetsToFetch = [...ASSET_TYPES, NEOM_TYPE];
                const newDecimals: Record<string, number> = {};
                for (const asset of assetsToFetch) {
                    try {
                        // Some assets might be wrapped types? getCoinMetadata usually works on Coin<T> types T.
                        const metadata = await client.getCoinMetadata({ coinType: asset });
                        if (metadata) {
                            newDecimals[asset] = metadata.decimals;
                        } else {
                            console.warn(`No metadata for ${asset}`);
                        }
                    } catch (e) {
                        console.warn(`Failed to fetch metadata for ${asset}`, e);
                    }
                }
                setDecimalsMap(prev => ({ ...prev, ...newDecimals }));

            } catch (e) {
                console.error("Failed to init market data", e);
            }
        };
        initData();
    }, [client]);

    const fetchMarketState = async (marketId: string) => {
        // Fetch MarketState and PyState
        try {
            // Get MarketState
            const marketObj = await client.getObject({
                id: marketId,
                options: { showContent: true }
            });

            if (marketObj.data?.content?.dataType === "moveObject") {
                const fields = marketObj.data.content.fields as any;
                const pyStateId = fields.py_state_id;

                // Get PyState
                const pyObj = await client.getObject({
                    id: pyStateId,
                    options: { showContent: true }
                });

                let pyIndex = 1.0; // Default
                if (pyObj.data?.content?.dataType === "moveObject") {
                    const pyFields = pyObj.data.content.fields as any;
                    // py_index_stored is FixedPoint64? (u64 inside fields?)
                    // Usually represented as a string or number in JSON.
                    // Struct: struct FixedPoint64 { value: u64 }
                    const rawIndex = pyFields.py_index_stored?.fields?.value || pyFields.py_index_stored;
                    // FixedPoint64 is usually Q64.64? Or just scaled by 2^64?
                    // In Sui Move, std::fixed_point32 is 2^32.
                    // Assuming 2^64.
                    if (rawIndex) {
                        // JavaScript limitation with 2^64. BigInt is needed.
                        const indexBig = BigInt(rawIndex);
                        const scale = BigInt(1) << BigInt(64);
                        // Convert to float for display estimation?
                        // underlying = user_sy * py_index
                        // py_index = rawIndex / 2^64
                        pyIndex = Number(indexBig) / Number(scale);
                    }
                }

                return {
                    lp_supply: BigInt(fields.lp_supply),
                    total_sy: BigInt(fields.total_sy), // Balance<T0> is usually value
                    total_pt: BigInt(fields.total_pt),
                    py_index: pyIndex,
                    expiry: fields.expiry
                };
            }
        } catch (e) {
            console.error("Error fetching market details", e);
        }
        return null;
    };

    const toggleAsset = (asset: string) => {
        const newSet = new Set(selectedAssets);
        if (newSet.has(asset)) {
            newSet.delete(asset);
        } else {
            newSet.add(asset);
        }
        setSelectedAssets(newSet);
    };

    const selectAll = () => {
        if (selectedAssets.size === ALL_ASSETS.length) {
            setSelectedAssets(new Set());
        } else {
            setSelectedAssets(new Set(ALL_ASSETS));
        }
    };

    const handleQuery = async () => {
        const addresses = addressesInput.split('\n').map(a => a.trim()).filter(a => a.length > 0);
        if (addresses.length === 0) {
            alert("Please enter at least one address");
            return;
        }

        setIsLoading(true);
        setResults({});

        console.log("Using RPC:", MAINNET_RPC_URL);

        try {
            for (const address of addresses) {
                const tx = new Transaction();

                // Always query NEOM
                tx.moveCall({
                    target: `${MAINNET_REPAY_PACKAGE_ID}::repay::get_claim_amount`,
                    typeArguments: [NEOM_TYPE],
                    arguments: [
                        tx.object(MAINNET_REPAY_REGISTRY_ID),
                        tx.pure.address(address),
                    ],
                });

                // Query selected assets
                const queriedAssets = Array.from(selectedAssets);
                for (const asset of queriedAssets) {
                    tx.moveCall({
                        target: `${MAINNET_REPAY_PACKAGE_ID}::repay::get_claim_amount`,
                        typeArguments: [asset],
                        arguments: [
                            tx.object(MAINNET_REPAY_REGISTRY_ID),
                            tx.pure.address(address),
                        ],
                    });
                }

                const result = await mainnetClient.devInspectTransactionBlock({
                    transactionBlock: tx,
                    sender: address,
                });

                const addressResults: { type: string, amount: string, underlying: string }[] = [];

                if (result.results) {
                    // Helper to decode U64 from bytes 
                    const decodeU64 = (bytes: number[]) => {
                        let val = 0n;
                        for (let i = 0; i < bytes.length; i++) {
                            val += BigInt(bytes[i]) << BigInt(8 * i);
                        }
                        return val.toString();
                    };

                    // Process NEOM result (first call)
                    if (result.results[0]?.returnValues) {
                        const bytes = result.results[0].returnValues[0][0];
                        const amountRaw = decodeU64(bytes);
                        const dec = decimalsMap[NEOM_TYPE] || 9;
                        const amountNum = Number(amountRaw) / Math.pow(10, dec);

                        if (amountNum > 0) {
                            addressResults.push({
                                type: NEOM_TYPE,
                                amount: amountNum.toFixed(4),
                                underlying: "0"
                            });
                        }
                    }

                    // Process other assets
                    await Promise.all(
                        queriedAssets.map(async (asset, index) => {
                            if (asset === NEOM_TYPE) return null;
                            try {
                                const res = result.results![index + 1];
                                let amountRaw = "0";
                                let amountStr = "0";
                                const dec = decimalsMap[asset] || 9;

                                if (res?.returnValues) {
                                    const bytes = res.returnValues[0][0];
                                    amountRaw = decodeU64(bytes);
                                    amountStr = (Number(amountRaw) / Math.pow(10, dec)).toFixed(4);
                                }

                                // Skip if amount is effectively zero
                                if (Number(amountStr) === 0) return null;

                                let underlyingVal = "0";

                                const marketId = marketMap[asset];
                                if (marketId) {
                                    const state = await fetchMarketState(marketId);
                                    if (state && state.lp_supply > 0) {
                                        const userLp = BigInt(amountRaw);
                                        const userSy = (userLp * state.total_sy) / state.lp_supply;
                                        const userPt = (userLp * state.total_pt) / state.lp_supply;
                                        const syUnderlying = Number(userSy) * state.py_index;
                                        const ptUnderlying = Number(userPt);
                                        const totalAppr = syUnderlying + ptUnderlying;
                                        underlyingVal = (totalAppr / Math.pow(10, dec)).toFixed(4);
                                    }
                                }

                                return {
                                    type: asset,
                                    amount: amountStr,
                                    underlying: underlyingVal
                                };
                            } catch (e) {
                                console.error(`Error querying ${asset}:`, e);
                                return null;
                            }
                        })
                    ).then(assetResults => {
                        const valid = assetResults.filter(r => r !== null) as any[];
                        addressResults.push(...valid);
                    });
                }

                setResults(prev => ({
                    ...prev,
                    [address]: addressResults
                }));
            }

        } catch (e) {
            console.error(e);
            alert("Failed to query: " + (e as Error).message);
        } finally {
            setIsLoading(false);
        }
    };

    const getAssetName = (type: string) => {
        const parts = type.split("::");
        return parts[parts.length - 1]; // e.g. SCALLOP_AF_SUI
    };

    return (
        <Flex direction="column" gap="4" my="4">
            <Heading size="4">Multi-Asset Claim Query</Heading>

            {/* {!currentAccount && (
                <Text color="red">Please connect wallet first</Text>
            )} */
                // Removed connect wallet warning as we support manual address input
            }

            <Card>
                <Flex direction="column" gap="3">
                    <Text size="2" weight="bold">Addresses (one per line)</Text>
                    <TextArea
                        placeholder="0x..."
                        rows={5}
                        value={addressesInput}
                        onChange={e => setAddressesInput(e.target.value)}
                    />

                    <Flex gap="2" align="center">
                        <Button variant="outline" onClick={selectAll}>
                            {selectedAssets.size === ALL_ASSETS.length ? "Deselect All" : "Select All"}
                        </Button>
                        <Text size="2" color="gray">Selected Assets: {selectedAssets.size}</Text>
                    </Flex>

                    <Grid columns="2" gap="2" style={{ maxHeight: '150px', overflowY: 'auto' }}>
                        {ALL_ASSETS.map((asset) => (
                            <Flex key={asset} gap="2" align="center">
                                <Checkbox
                                    checked={selectedAssets.has(asset)}
                                    // @ts-ignore
                                    onCheckedChange={() => toggleAsset(asset)}
                                />
                                <Text size="1" style={{ wordBreak: 'break-all' }}>
                                    {getAssetName(asset)}
                                </Text>
                            </Flex>
                        ))}
                    </Grid>

                    <Button onClick={handleQuery} disabled={isLoading}>
                        {isLoading ? "Querying..." : "Query Addresses"}
                    </Button>
                </Flex>
            </Card>

            {Object.entries(results).map(([address, rows]) => (
                <Card key={address}>
                    <Flex direction="column" gap="2">
                        <Heading size="3">Address: {address}</Heading>
                        {rows.length > 0 ? (
                            <Table.Root>
                                <Table.Header>
                                    <Table.Row>
                                        <Table.ColumnHeaderCell>Asset Type</Table.ColumnHeaderCell>
                                        <Table.ColumnHeaderCell>Claimable LP</Table.ColumnHeaderCell>
                                        <Table.ColumnHeaderCell>Underlying Value</Table.ColumnHeaderCell>
                                    </Table.Row>
                                </Table.Header>

                                <Table.Body>
                                    {rows.map((row) => (
                                        <Table.Row key={row.type}>
                                            <Table.Cell>
                                                <BlockCopy text={row.type} />
                                            </Table.Cell>
                                            <Table.Cell>{row.amount}</Table.Cell>
                                            <Table.Cell>{row.underlying}</Table.Cell>
                                        </Table.Row>
                                    ))}
                                </Table.Body>
                            </Table.Root>
                        ) : (
                            <Text color="gray">No claimable assets found.</Text>
                        )}
                    </Flex>
                </Card>
            ))}
        </Flex>
    );
}
