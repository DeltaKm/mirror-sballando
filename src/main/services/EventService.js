class EventService {
  constructor(databaseService) {
    this.databaseService = databaseService;
  }

  getCurrentEvent() {
    return {
      id: null,
      title: 'Nessun evento selezionato'
    };
  }
}

module.exports = { EventService };
