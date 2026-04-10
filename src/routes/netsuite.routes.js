const express = require('express');
const router = express.Router();
const netsuiteController = require('../controllers/netsuite.controller');

// APIs for NetSuite scripts to push data
router.post('/webhook/tables', netsuiteController.receiveTables);
router.post('/webhook/columns/:tableName', netsuiteController.receiveColumns);
router.post('/webhook/data/:tableName', netsuiteController.receiveData);



module.exports = router;