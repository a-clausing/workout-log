/**
 * Workout Log — Supabase data layer (per-user auth version).
 *
 * The Project URL and publishable key below are meant to be public — that's
 * how every Supabase app ships. They are NOT what protects your data; the
 * database's Row Level Security policies (see supabase/schema.sql) are what
 * actually restrict each signed-in user to their own rows. Don't put a
 * `service_role` / secret key here — that one DOES need to stay private.
 */
var SUPABASE_URL = 'https://hrnkuamsybsrbxiuwpib.supabase.co';
var SUPABASE_ANON_KEY = 'sb_publishable_kJIdV9A-fmM7kRRvhsMkdQ_TluKpyBi';

(function () {
  'use strict';

  var SCHEDULE_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  if (!window.supabase || !window.supabase.createClient) {
    window.WorkoutAPI = { loadError: 'supabase-js failed to load (check your internet connection).' };
    return;
  }

  var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  var _session = undefined; // undefined = not checked yet, null = signed out, object = signed in

  sb.auth.onAuthStateChange(function (_event, session) { _session = session; });
  var initialSessionPromise = sb.auth.getSession().then(function (res) {
    _session = res.data.session;
    return _session;
  });

  function client() { return sb; }

  // Unwrap a supabase-js { data, error } result or throw.
  function take(res) {
    if (res.error) throw new Error(res.error.message || String(res.error));
    return res.data;
  }

  function toArray(v) {
    if (Array.isArray(v)) return v.map(function (s) { return String(s).trim(); }).filter(Boolean);
    if (v === null || v === undefined || v === '') return [];
    return String(v).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  }

  // ---------- shared read helpers ----------

  function exerciseNameMap() {
    return client().from('exercises').select('id,name,category,equipment').then(take).then(function (rows) {
      var map = {};
      (rows || []).forEach(function (r) {
        map[r.id] = { name: r.name, category: r.category || '', equipment: r.equipment || '' };
      });
      return map;
    });
  }

  function templateNameMap() {
    return client().from('workout_templates').select('id,name').then(take).then(function (rows) {
      var map = {};
      (rows || []).forEach(function (r) { map[r.id] = r.name; });
      return map;
    });
  }

  function mapTemplate(row, exMap) {
    var items = Array.isArray(row.exercises) ? row.exercises : [];
    var exercises = items.map(function (it) {
      var ex = exMap[it.exerciseId] || { name: 'Unknown exercise' };
      return { exerciseId: it.exerciseId, name: ex.name, setsReps: it.setsReps || [] };
    });
    return {
      id: row.id,
      name: row.name,
      exercises: exercises,
      exerciseCount: exercises.length,
      totalSets: exercises.reduce(function (n, e) { return n + e.setsReps.length; }, 0),
      durationMinutes: row.duration_minutes != null ? Number(row.duration_minutes) : null,
      tags: toArray(row.tags)
    };
  }

  function normalizeSchedule(schedule) {
    var map = {};
    (schedule || []).forEach(function (s) { if (s && s.day) map[s.day] = s.workoutId || ''; });
    return SCHEDULE_DAYS.map(function (day) { return { day: day, workoutId: map[day] || '' }; });
  }

  function mapProgram(row, nameMap) {
    var schedule = normalizeSchedule(row.schedule).map(function (s) {
      return {
        day: s.day,
        workoutId: s.workoutId,
        workoutName: s.workoutId ? (nameMap[s.workoutId] || 'Unknown workout') : ''
      };
    });
    return {
      id: row.id,
      name: row.name,
      durationWeeks: row.duration_weeks != null ? Number(row.duration_weeks) : null,
      schedule: schedule,
      workoutCount: schedule.filter(function (s) { return s.workoutId; }).length,
      active: !!row.active
    };
  }

  // ---------- GET actions ----------

  var GET = {
    getExercises: function () {
      return client().from('exercises').select('*').order('name', { ascending: true })
        .then(take).then(function (rows) {
          return (rows || []).map(function (r) {
            return {
              id: r.id, name: r.name,
              category: r.category || '', equipment: r.equipment || '',
              muscles: toArray(r.muscles)
            };
          });
        });
    },

    getWorkouts: function () {
      return client().from('workouts_with_counts').select('*')
        .order('date', { ascending: false }).order('created_at', { ascending: false })
        .then(take).then(function (rows) {
          return (rows || []).map(function (r) {
            return {
              id: r.id,
              date: String(r.date),
              name: r.name || 'Workout',
              notes: r.notes || '',
              exerciseCount: Number(r.exercise_count) || 0,
              setCount: Number(r.set_count) || 0
            };
          });
        });
    },

    getWorkout: function (params) {
      var id = params && params.id;
      if (!id) throw new Error('Workout id is required');
      return Promise.all([
        client().from('workouts').select('*').eq('id', id).single().then(take),
        client().from('sets')
          .select('id,workout_id,block_id,exercise_id,weight,reps,position,exercises(name,category,equipment)')
          .eq('workout_id', id).order('position', { ascending: true }).then(take)
      ]).then(function (out) {
        var w = out[0];
        var sets = (out[1] || []).map(function (r) {
          var ex = r.exercises || { name: 'Unknown exercise', category: '', equipment: '' };
          return {
            id: r.id,
            workoutId: r.workout_id,
            blockId: r.block_id,
            exerciseId: r.exercise_id,
            exerciseName: ex.name,
            exerciseCategory: ex.category || '',
            exerciseEquipment: ex.equipment || '',
            weight: r.weight,
            reps: r.reps
          };
        });
        return {
          id: w.id, date: String(w.date), name: w.name || 'Workout', notes: w.notes || '', sets: sets
        };
      });
    },

    getExerciseRecords: function (params) {
      var exerciseId = params && params.exerciseId;
      if (!exerciseId) throw new Error('Exercise id is required');
      return client().from('sets').select('weight,reps').eq('exercise_id', exerciseId)
        .then(take).then(function (rows) {
          var byReps = {};
          (rows || []).forEach(function (r) {
            var reps = Number(r.reps), weight = Number(r.weight);
            if (isNaN(reps) || isNaN(weight)) return;
            if (!(reps in byReps) || weight > byReps[reps]) byReps[reps] = weight;
          });
          return Object.keys(byReps)
            .map(function (k) { return { reps: Number(k), weight: byReps[k] }; })
            .sort(function (a, b) { return a.reps - b.reps; });
        });
    },

    getWorkoutTemplates: function () {
      return Promise.all([
        client().from('workout_templates').select('*').order('created_at', { ascending: true }).then(take),
        exerciseNameMap()
      ]).then(function (out) {
        return (out[0] || []).map(function (row) { return mapTemplate(row, out[1]); });
      });
    },

    getPrograms: function () {
      return Promise.all([
        client().from('programs').select('*').order('created_at', { ascending: true }).then(take),
        templateNameMap()
      ]).then(function (out) {
        return (out[0] || []).map(function (row) { return mapProgram(row, out[1]); });
      });
    }
  };

  // ---------- POST actions ----------

  function buildSetRows(workoutId, items) {
    var rows = [];
    (items || []).forEach(function (item) {
      (item.sets || []).forEach(function (s) {
        rows.push({
          workout_id: workoutId,
          block_id: item.blockId || null,
          exercise_id: item.exerciseId,
          weight: s.weight,
          reps: s.reps,
          position: rows.length
        });
      });
    });
    return rows;
  }

  var POST = {
    addExercise: function (b) {
      var name = (b.name || '').trim();
      if (!name) throw new Error('Exercise name is required');
      return client().from('exercises').insert({
        name: name, category: b.category || '', equipment: b.equipment || '', muscles: toArray(b.muscles)
      }).select().single().then(take).then(function (r) {
        return { id: r.id, name: r.name, category: r.category || '', equipment: r.equipment || '', muscles: toArray(r.muscles) };
      });
    },

    updateExercise: function (b) {
      if (!b.id) throw new Error('Exercise id is required');
      var name = (b.name || '').trim();
      if (!name) throw new Error('Exercise name is required');
      return client().from('exercises').update({
        name: name, category: b.category || '', equipment: b.equipment || '', muscles: toArray(b.muscles)
      }).eq('id', b.id).select().single().then(take).then(function (r) {
        return { id: r.id, name: r.name, category: r.category || '', equipment: r.equipment || '', muscles: toArray(r.muscles) };
      });
    },

    deleteExercise: function (b) {
      if (!b.id) throw new Error('Exercise id is required');
      return client().from('sets').select('id', { count: 'exact', head: true }).eq('exercise_id', b.id)
        .then(function (res) {
          if (res.error) throw new Error(res.error.message);
          if (res.count > 0) throw new Error('This exercise has logged sets and cannot be deleted.');
          return client().from('exercises').delete().eq('id', b.id).then(take);
        }).then(function () { return { id: b.id, deleted: true }; });
    },

    saveWorkout: function (b) {
      if (!b.date) throw new Error('Workout date is required');
      if (!b.items || !b.items.length) throw new Error('Workout has no exercises to save');
      return client().from('workouts').insert({
        date: b.date, name: (b.name || '').trim() || 'Workout', notes: ''
      }).select().single().then(take).then(function (w) {
        var rows = buildSetRows(w.id, b.items);
        if (!rows.length) throw new Error('Workout has no sets to save');
        return client().from('sets').insert(rows).then(take).then(function () {
          return { id: w.id, date: b.date, setCount: rows.length };
        });
      });
    },

    updateWorkout: function (b) {
      if (!b.id) throw new Error('Workout id is required');
      if (!b.date) throw new Error('Workout date is required');
      if (!b.items || !b.items.length) throw new Error('Workout has no exercises to save');
      var rows = buildSetRows(b.id, b.items);
      if (!rows.length) throw new Error('Workout has no sets to save');
      return client().from('workouts').update({
        date: b.date, name: (b.name || '').trim() || 'Workout'
      }).eq('id', b.id).then(take)
        .then(function () { return client().from('sets').delete().eq('workout_id', b.id).then(take); })
        .then(function () { return client().from('sets').insert(rows).then(take); })
        .then(function () { return { id: b.id, date: b.date, setCount: rows.length }; });
    },

    deleteWorkout: function (b) {
      if (!b.id) throw new Error('Workout id is required');
      // sets are removed automatically (ON DELETE CASCADE)
      return client().from('workouts').delete().eq('id', b.id).then(take)
        .then(function () { return { id: b.id, deleted: true }; });
    },

    addWorkoutTemplate: function (b) {
      var name = (b.name || '').trim();
      if (!name) throw new Error('Workout name is required');
      if (!b.exercises || !b.exercises.length) throw new Error('Add at least one exercise');
      var items = b.exercises.map(function (x) { return { exerciseId: x.exerciseId, setsReps: x.setsReps || [] }; });
      return client().from('workout_templates').insert({
        name: name, exercises: items,
        duration_minutes: b.durationMinutes || null, tags: toArray(b.tags)
      }).select().single().then(take).then(function (row) {
        return exerciseNameMap().then(function (m) { return mapTemplate(row, m); });
      });
    },

    updateWorkoutTemplate: function (b) {
      if (!b.id) throw new Error('Workout id is required');
      var name = (b.name || '').trim();
      if (!name) throw new Error('Workout name is required');
      if (!b.exercises || !b.exercises.length) throw new Error('Add at least one exercise');
      var items = b.exercises.map(function (x) { return { exerciseId: x.exerciseId, setsReps: x.setsReps || [] }; });
      return client().from('workout_templates').update({
        name: name, exercises: items,
        duration_minutes: b.durationMinutes || null, tags: toArray(b.tags)
      }).eq('id', b.id).select().single().then(take).then(function (row) {
        return exerciseNameMap().then(function (m) { return mapTemplate(row, m); });
      });
    },

    deleteWorkoutTemplate: function (b) {
      if (!b.id) throw new Error('Workout id is required');
      return client().from('workout_templates').delete().eq('id', b.id).then(take)
        .then(function () { return { id: b.id, deleted: true }; });
    },

    addProgram: function (b) {
      var name = (b.name || '').trim();
      if (!name) throw new Error('Program name is required');
      var chain = b.active
        ? client().from('programs').update({ active: false }).eq('active', true).then(take)
        : Promise.resolve();
      return chain.then(function () {
        return client().from('programs').insert({
          name: name, duration_weeks: b.durationWeeks || null,
          schedule: normalizeSchedule(b.schedule), active: !!b.active
        }).select().single().then(take);
      }).then(function (row) {
        return templateNameMap().then(function (m) { return mapProgram(row, m); });
      });
    },

    updateProgram: function (b) {
      if (!b.id) throw new Error('Program id is required');
      var name = (b.name || '').trim();
      if (!name) throw new Error('Program name is required');
      var chain = b.active
        ? client().from('programs').update({ active: false }).eq('active', true).neq('id', b.id).then(take)
        : Promise.resolve();
      return chain.then(function () {
        return client().from('programs').update({
          name: name, duration_weeks: b.durationWeeks || null,
          schedule: normalizeSchedule(b.schedule), active: !!b.active
        }).eq('id', b.id).select().single().then(take);
      }).then(function (row) {
        return templateNameMap().then(function (m) { return mapProgram(row, m); });
      });
    },

    deleteProgram: function (b) {
      if (!b.id) throw new Error('Program id is required');
      return client().from('programs').delete().eq('id', b.id).then(take)
        .then(function () { return { id: b.id, deleted: true }; });
    }
  };

  // ---------- auth ----------

  function signIn(email, password) {
    return sb.auth.signInWithPassword({ email: email, password: password }).then(function (res) {
      if (res.error) throw new Error(res.error.message || 'Sign in failed');
      _session = res.data.session;
      return _session;
    });
  }
  function signOut() {
    return sb.auth.signOut().then(function () { _session = null; });
  }
  function getSession() {
    // resolves once the initial check has run, then reflects live state
    return initialSessionPromise.then(function () { return _session; });
  }
  function getCachedSession() { return _session || null; }

  // ---------- public surface ----------

  window.WorkoutAPI = {
    signIn: signIn,
    signOut: signOut,
    getSession: getSession,
    getCachedSession: getCachedSession,
    apiGet: function (action, params) {
      return Promise.resolve().then(function () {
        if (!GET[action]) throw new Error('Unknown action: ' + action);
        return GET[action](params || {});
      });
    },
    apiPost: function (action, payload) {
      return Promise.resolve().then(function () {
        if (!POST[action]) throw new Error('Unknown action: ' + action);
        return POST[action](payload || {});
      });
    }
  };
})();
