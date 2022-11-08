import * as encoder from '../../../../src/utils/encoder';
import { DidKeyResolver } from '../../../../src/did/did-key-resolver';
import { DidResolver } from '../../../../src';
import { handleCollectionsQuery } from '../../../../src/interfaces/collections/handlers/collections-query';
import { MessageStoreLevel } from '../../../../src/store/message-store-level';
import { TestDataGenerator } from '../../../utils/test-data-generator';
import { TestStubGenerator } from '../../../utils/test-stub-generator';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import { handleCollectionsWrite } from '../../../../src/interfaces/collections/handlers/collections-write';

chai.use(chaiAsPromised);

describe('handleCollectionsQuery()', () => {
  describe('functional tests', () => {
    let didResolver: DidResolver;
    let messageStore: MessageStoreLevel;

    before(async () => {
      // important to follow this pattern to initialize the message store in tests
      // so that different suites can reuse the same block store and index location for testing
      messageStore = new MessageStoreLevel({
        blockstoreLocation : 'TEST-BLOCKSTORE',
        indexLocation      : 'TEST-INDEX'
      });

      await messageStore.open();

      didResolver = new DidResolver([new DidKeyResolver()]);
    });

    beforeEach(async () => {
      await messageStore.clear(); // clean up before each test rather than after so that a test does not depend on other tests to do the clean up
    });

    after(async () => {
      await messageStore.close();
    });

    it('should return records matching the query', async () => {
      // insert three messages into DB, two with matching protocol
      const alice = await TestDataGenerator.generatePersona();
      const protocol = 'myAwesomeProtocol';
      const write1Data = await TestDataGenerator.generateCollectionsWriteMessage({ requester: alice, target: alice });
      const write2Data = await TestDataGenerator.generateCollectionsWriteMessage({ requester: alice, target: alice, protocol, schema: 'schema1' });
      const write3Data = await TestDataGenerator.generateCollectionsWriteMessage({ requester: alice, target: alice, protocol, schema: 'schema2' });

      await messageStore.put(write1Data.message, { author: alice.did });
      await messageStore.put(write2Data.message, { author: alice.did });
      await messageStore.put(write3Data.message, { author: alice.did });

      // testing singular conditional query
      const messageData = await TestDataGenerator.generateCollectionsQueryMessage({ requester: alice, target: alice, filter: { protocol } });

      // setting up a stub method resolver
      const didResolverStub = TestStubGenerator.createDidResolverStub(alice);

      const reply = await handleCollectionsQuery(messageData.message, messageStore, didResolverStub);

      expect(reply.status.code).to.equal(200);
      expect(reply.entries?.length).to.equal(2); // only 2 entries should match the query on protocol

      // testing multi-conditional query, reuse data generated above for bob
      const messageData2 = await TestDataGenerator.generateCollectionsQueryMessage({
        requester : alice,
        target    : alice,
        filter    : {
          protocol,
          schema: 'schema1'
        }
      });

      const reply2 = await handleCollectionsQuery(messageData2.message, messageStore, didResolverStub);

      expect(reply2.status.code).to.equal(200);
      expect(reply2.entries?.length).to.equal(1); // only 1 entry should match the query
    });

    it('should only return published records and unpublished records that is meant for requester', async () => {
      // write three records into Alice's DB:
      // 1st is unpublished
      // 2nd is also unpublished but is meant for (has recipient as) Bob
      // 3rd is also unpublished but is authored (sent) by Bob
      // 4th is published
      const alice = await DidKeyResolver.generate();
      const bob = await DidKeyResolver.generate();
      const schema = 'schema1';
      const record1Data = await TestDataGenerator.generateCollectionsWriteMessage(
        { requester: alice, target: alice, schema, data: encoder.stringToBytes('1') }
      );
      const record2Data = await TestDataGenerator.generateCollectionsWriteMessage(
        { requester: alice, target: alice, schema, data: encoder.stringToBytes('2'), recipientDid: bob.did }
      );
      const record3Data = await TestDataGenerator.generateCollectionsWriteMessage(
        { requester: bob, target: alice, recipientDid: alice.did, schema, data: encoder.stringToBytes('3') }
      );
      const record4Data = await TestDataGenerator.generateCollectionsWriteMessage(
        { requester: alice, target: alice, schema, data: encoder.stringToBytes('4'), published: true, datePublished: 123 }
      );

      await messageStore.put(record1Data.message, { author: alice.did });
      await messageStore.put(record2Data.message, { author: alice.did });
      await messageStore.put(record3Data.message, { author: bob.did });
      await messageStore.put(record4Data.message, { author: alice.did });

      // test correctness for Bob's query
      const bobQueryMessageData = await TestDataGenerator.generateCollectionsQueryMessage({
        requester : bob,
        target    : alice,
        filter    : { schema }
      });

      const replyToBob = await handleCollectionsQuery(bobQueryMessageData.message, messageStore, didResolver);

      expect(replyToBob.status.code).to.equal(200);
      expect(replyToBob.entries?.length).to.equal(3); // expect 3 records

      const privateRecordsForBob = replyToBob.entries.filter(message => (message as any).encodedData === encoder.stringToBase64Url('2'));
      const privateRecordsFromBob = replyToBob.entries.filter(message => (message as any).encodedData === encoder.stringToBase64Url('3'));
      const publicRecords = replyToBob.entries.filter(message => (message as any).encodedData === encoder.stringToBase64Url('4'));
      expect(privateRecordsForBob.length).to.equal(1);
      expect(privateRecordsFromBob.length).to.equal(1);
      expect(publicRecords.length).to.equal(1);

      // test correctness for Alice's query
      const aliceQueryMessageData = await TestDataGenerator.generateCollectionsQueryMessage({
        requester : alice,
        target    : alice,
        filter    : { schema }
      });

      const replyToAliceQuery = await handleCollectionsQuery(aliceQueryMessageData.message, messageStore, didResolver);

      expect(replyToAliceQuery.status.code).to.equal(200);
      expect(replyToAliceQuery.entries?.length).to.equal(4); // expect all 4 records
    });


    it('should throw if querying for records not intended for the requester', async () => {
      const alice = await DidKeyResolver.generate();
      const bob = await DidKeyResolver.generate();
      const carol = await DidKeyResolver.generate();

      // test correctness for Bob's query
      const bobQueryMessageData = await TestDataGenerator.generateCollectionsQueryMessage({
        requester : bob,
        target    : alice,
        filter    : { recipient: carol.did } // bob querying carol's records
      });

      const replyToBobQuery = await handleCollectionsQuery(bobQueryMessageData.message, messageStore, didResolver);

      expect(replyToBobQuery.status.code).to.equal(401);
      expect(replyToBobQuery.status.detail).to.contain('not allowed to query records');
    });

    it('should not fetch entries across tenants', async () => {
      // insert three messages into DB, two with matching schema
      const alice = await DidKeyResolver.generate();
      const bob = await DidKeyResolver.generate();
      const schema = 'myAwesomeSchema';
      const collectionsWriteMessage1Data = await TestDataGenerator.generateCollectionsWriteMessage({ requester: alice, target: alice, schema });
      const collectionsWriteMessage2Data = await TestDataGenerator.generateCollectionsWriteMessage({ requester: bob, target: bob, schema });

      const aliceQueryMessageData = await TestDataGenerator.generateCollectionsQueryMessage({
        requester : alice,
        target    : alice,
        filter    : { schema }
      });

      // insert data into 2 different tenants
      const didResolver = new DidResolver([new DidKeyResolver()]);
      await handleCollectionsWrite(collectionsWriteMessage1Data.message, messageStore, didResolver);
      await handleCollectionsWrite(collectionsWriteMessage2Data.message, messageStore, didResolver);

      const reply = await handleCollectionsQuery(aliceQueryMessageData.message, messageStore, didResolver);

      expect(reply.status.code).to.equal(200);
      expect(reply.entries?.length).to.equal(1);
    });
  });

  it('should return 401 if signature check fails', async () => {
    const { requester, message } = await TestDataGenerator.generateCollectionsQueryMessage();

    // setting up a stub did resolver & message store
    // intentionally not supplying the public key so a different public key is generated to simulate invalid signature
    const mismatchingPersona = await TestDataGenerator.generatePersona({ did: requester.did, keyId: requester.keyId });
    const didResolverStub = TestStubGenerator.createDidResolverStub(mismatchingPersona);
    const messageStoreStub = sinon.createStubInstance(MessageStoreLevel);

    const reply = await handleCollectionsQuery(message, messageStoreStub, didResolverStub);

    expect(reply.status.code).to.equal(401);
  });

  it('should return 500 if authorization fails', async () => {
    const { requester, message } = await TestDataGenerator.generateCollectionsQueryMessage();

    // setting up a stub method resolver & message store
    const didResolverStub = TestStubGenerator.createDidResolverStub(requester);
    const messageStoreStub = sinon.createStubInstance(MessageStoreLevel);
    messageStoreStub.query.throwsException('anyError'); // simulate a DB query error

    const reply = await handleCollectionsQuery(message, messageStoreStub, didResolverStub);

    expect(reply.status.code).to.equal(500);
  });

  it('should return 500 if query contains `dateSort`', async () => {
    const { requester, message } = await TestDataGenerator.generateCollectionsQueryMessage({ dateSort: 'createdAscending' });

    // setting up a stub method resolver & message store
    const didResolverStub = TestStubGenerator.createDidResolverStub(requester);
    const messageStoreStub = sinon.createStubInstance(MessageStoreLevel);
    messageStoreStub.query.throwsException('anyError'); // simulate a DB query error

    const reply = await handleCollectionsQuery(message, messageStoreStub, didResolverStub);

    expect(reply.status.code).to.equal(500);
    expect(reply.status.detail).to.equal('`dateSort` not implemented');
  });
});

