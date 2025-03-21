import { ethers } from "hardhat";
import { expect } from "chai";
import { Contract } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { MonitoringService, AlertLevel } from "../../src/utils/MonitoringService";
import { BridgeService } from "../../src/services/BridgeService";

describe("Bridge Monitoring Integration", function () {
    let sourceChainBridge: Contract;
    let targetChainBridge: Contract;
    let sourceChainGovernance: Contract;
    let targetChainGovernance: Contract;
    let owner: SignerWithAddress;
    let operators: SignerWithAddress[];
    let admins: SignerWithAddress[];
    let monitoringService: MonitoringService;
    let sourceBridgeService: BridgeService;
    let targetBridgeService: BridgeService;

    const mockConfig = {
        alertThresholds: {
            transactionDelay: 5000,
            signatureDelay: 3000,
            errorRate: 10,
            blockConfirmations: 12,
            crossChainLatency: 10000
        },
        healthCheckInterval: 1000
    };

    before(async function () {
        [owner, ...operators] = await ethers.getSigners();
        admins = operators.slice(0, 2);
        operators = operators.slice(2, 4);

        // Deploy contracts
        const BridgeGovernance = await ethers.getContractFactory("BridgeGovernance");
        sourceChainGovernance = await BridgeGovernance.deploy();
        await sourceChainGovernance.deployed();

        const BridgeMirror = await ethers.getContractFactory("BridgeMirror");
        sourceChainBridge = await BridgeMirror.deploy(sourceChainGovernance.address);
        await sourceChainBridge.deployed();

        targetChainGovernance = await BridgeGovernance.deploy();
        await targetChainGovernance.deployed();

        targetChainBridge = await BridgeMirror.deploy(targetChainGovernance.address);
        await targetChainBridge.deployed();

        // Initialize monitoring
        monitoringService = new MonitoringService(mockConfig);

        // Initialize bridge services
        sourceBridgeService = new BridgeService(
            ethers.provider,
            sourceChainBridge.address,
            sourceChainGovernance.address,
            BridgeMirror.interface,
            BridgeGovernance.interface,
            monitoringService
        );

        targetBridgeService = new BridgeService(
            ethers.provider,
            targetChainBridge.address,
            targetChainGovernance.address,
            BridgeMirror.interface,
            BridgeGovernance.interface,
            monitoringService
        );

        // Setup roles and monitoring
        await setupChainRoles(sourceChainGovernance);
        await setupChainRoles(targetChainGovernance);
        monitoringService.addNetwork(1, ethers.provider); // Source chain
        monitoringService.addNetwork(2, ethers.provider); // Target chain
    });

    async function setupChainRoles(governance: Contract) {
        const ADMIN_ROLE = 2;
        const OPERATOR_ROLE = 1;

        for (const admin of admins) {
            await governance.assignRole(admin.address, ADMIN_ROLE);
        }

        for (const operator of operators) {
            await governance.assignRole(operator.address, OPERATOR_ROLE);
        }

        await governance.updateThreshold(2);
    }

    describe("Cross-Chain Transaction Monitoring", function () {
        it("Should track transaction lifecycle and emit appropriate alerts", async function () {
            // Enable required features
            await sourceBridgeService.toggleFeature("CROSS_CHAIN_MIRROR", true);
            await targetBridgeService.toggleFeature("CROSS_CHAIN_MIRROR", true);

            const alerts: any[] = [];
            monitoringService.on('alert', (alert) => alerts.push(alert));

            // Propose and execute a cross-chain transaction
            const testData = ethers.utils.defaultAbiCoder.encode(
                ["string", "uint256"],
                ["test_action", 123]
            );

            // Track metrics before transaction
            const initialMetrics = monitoringService.getMetrics();

            // Initiate transaction
            const txHash = await sourceBridgeService.proposeTransaction(
                targetChainBridge.address,
                0,
                testData
            );

            // Get signatures
            await Promise.all(admins.map(admin => 
                sourceBridgeService.signTransaction(txHash)
            ));

            // Execute transaction
            await sourceBridgeService.executeTransaction(txHash);

            // Wait for monitoring updates
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Verify metrics and alerts
            const finalMetrics = monitoringService.getMetrics();
            expect(finalMetrics.totalTransactions).to.equal(initialMetrics.totalTransactions + 1);
            expect(finalMetrics.successfulTransactions).to.equal(initialMetrics.successfulTransactions + 1);

            // Verify alerts were emitted
            expect(alerts.some(a => a.level === AlertLevel.INFO && a.message.includes("signature threshold"))).to.be.true;
            expect(alerts.some(a => a.level === AlertLevel.INFO && a.message.includes("executed successfully"))).to.be.true;
        });

        it("Should detect and alert on high latency", async function () {
            // Mock a slow transaction
            const alerts: any[] = [];
            monitoringService.on('alert', (alert) => alerts.push(alert));

            const txHash = ethers.utils.formatBytes32String("slow_tx");
            monitoringService.trackTransaction(txHash, 1, 2);

            // Wait longer than the latency threshold
            await new Promise(resolve => setTimeout(resolve, mockConfig.alertThresholds.crossChainLatency + 100));

            // Verify latency alert was emitted
            expect(alerts.some(a => 
                a.level === AlertLevel.WARNING && 
                a.message.includes("High latency")
            )).to.be.true;

            // Clean up
            monitoringService.confirmTransaction(txHash, true);
        });

        it("Should track error rates and emit alerts", async function () {
            const alerts: any[] = [];
            monitoringService.on('alert', (alert) => alerts.push(alert));

            // Simulate failed transactions
            const numFailures = Math.ceil(mockConfig.alertThresholds.errorRate / 100 * 10) + 1;
            
            for (let i = 0; i < numFailures; i++) {
                const txHash = ethers.utils.formatBytes32String(`failed_tx_${i}`);
                monitoringService.trackTransaction(txHash, 1, 2);
                monitoringService.confirmTransaction(txHash, false);
            }

            // Verify error rate alert was emitted
            expect(alerts.some(a => 
                a.level === AlertLevel.CRITICAL && 
                a.message.includes("High error rate")
            )).to.be.true;
        });
    });

    describe("Chain Health Monitoring", function () {
        it("Should monitor chain health and recover from failures", async function () {
            const alerts: any[] = [];
            monitoringService.on('alert', (alert) => alerts.push(alert));

            // Start monitoring
            await monitoringService.startMonitoring();

            // Wait for initial health check
            await new Promise(resolve => setTimeout(resolve, mockConfig.healthCheckInterval + 100));

            // Verify chain health status
            const healthStatus = monitoringService.getHealthStatus();
            expect(healthStatus.chainHealth.get(1)).to.be.true;
            expect(healthStatus.chainHealth.get(2)).to.be.true;

            // Cleanup
            monitoringService.removeAllListeners();
        });
    });
});